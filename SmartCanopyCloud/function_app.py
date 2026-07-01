import azure.functions as func
import logging
import json
import os
import requests
from datetime import datetime
from azure.iot.hub import IoTHubRegistryManager
from azure.data.tables import TableClient

app = func.FunctionApp()

registry_manager = None
last_sent_command = None 

def get_registry_manager():
    global registry_manager
    if registry_manager is None:
        iot_hub_connection_string = os.environ["IOT_HUB_CONNECTION_STRING"]
        registry_manager = IoTHubRegistryManager(iot_hub_connection_string)
    return registry_manager

# Thresholds
DRY_WEIGHT_THRESHOLD = 50000
DARK_LIGHT_THRESHOLD = 3000

def get_satellite_weather(api_key: str) -> dict:
    weather_url = f"http://api.openweathermap.org/data/2.5/weather?lat=6.8446&lon=79.8711&appid={api_key}&units=metric"
    try:
        response = requests.get(weather_url, timeout=5)
        response.raise_for_status() 
        return response.json()
    except Exception as e:
        logging.error(f"Weather API Error: {e}")
        return {}

def is_rain_upcoming(weather_data: dict) -> bool:
    if "weather" in weather_data:
        for condition in weather_data["weather"]:
            desc = condition.get("description", "").lower()
            if any(keyword in desc for keyword in ["rain", "drizzle", "thunderstorm"]):
                return True
    return False

def make_smart_decision(sensor_data: dict, upcoming_rain: bool) -> str:
    is_raining_now = sensor_data.get("raining", False)
    
    # 🚨 CRITICAL FIX: Properly extract "weight_raw"
    weight = sensor_data.get("weight_raw", 0)
    light = sensor_data.get("light_raw", 0)

    is_dark = light > DARK_LIGHT_THRESHOLD
    clothes_are_wet = weight >= DRY_WEIGHT_THRESHOLD
    no_clothes = weight < 1000
    clothes_are_dry = not clothes_are_wet and not no_clothes

    protect_clothesline = False
    protect_window = False

    if is_raining_now or upcoming_rain:
        protect_clothesline = True
        protect_window = True
    elif is_dark:
        protect_window = True
        protect_clothesline = clothes_are_dry # Only bring them in at night if they are dry
    else:
        protect_window = False
        protect_clothesline = clothes_are_dry # Bring them in if they are dry during the day

    if protect_clothesline and protect_window:
        return "all_protect"
    elif protect_clothesline:
        return "cover_clothesline"
    elif protect_window:
        return "close_window"
    else:
        return "all_safe"

def send_c2d_command(device_id: str, command: str, source: str = "ai"):
    global registry_manager
    try:
        rm = get_registry_manager()
        data_to_send = json.dumps({"command": command, "source": source})
        rm.send_c2d_message(device_id, data_to_send)
        logging.info(f"SUCCESS: '{command}' sent to {device_id}!")
    except Exception as e:
        logging.error(f"Failed to send C2D message: {e}")
        registry_manager = None 

@app.event_hub_message_trigger(arg_name="azeventhub", event_hub_name="uok-weather-hub", connection="EVENT_HUB_CONNECTION_STRING")
def WeatherDecisionEngine(azeventhub: func.EventHubEvent):
    global last_sent_command
    try:
        weather_api_key = os.environ.get("OPENWEATHER_API_KEY", "")
        message_body = azeventhub.get_body().decode('utf-8')
        sensor_data = json.loads(message_body)
        device_id = sensor_data.get("device_id", "esp32-weather")

        weather_data = get_satellite_weather(weather_api_key)
        upcoming_rain = is_rain_upcoming(weather_data)

        command = make_smart_decision(sensor_data, upcoming_rain)
        system_active = sensor_data.get("system_active", True)
        
        # 🚨 CRITICAL FIX: Only send ONE command to prevent ESP32 spam
        if system_active and command != last_sent_command:
            logging.info(f"DECISION CHANGED: Triggering state -> {command}")
            send_c2d_command(device_id, command, "ai")
            last_sent_command = command

        # Save to Database
        try:
            # 🚨 CRITICAL FIX: Extract weight_raw to save into the database
            weight_val = sensor_data.get("weight_raw", 0)
            
            db_conn_string = os.environ["AzureWebJobsStorage"]
            table_client = TableClient.from_connection_string(conn_str=db_conn_string, table_name="SensorData")
            
            try:
                table_client.create_table()
            except Exception:
                pass 

            current_time = datetime.now()
            entity = {
                "PartitionKey": device_id,
                "RowKey": str(int(current_time.timestamp() * 1000)),
                "time": current_time.strftime("%H:%M:%S"),
                "temp": sensor_data.get("temperature", 0),
                "humidity": sensor_data.get("humidity", 0),
                "light": sensor_data.get("light_raw", 0),
                "rain": sensor_data.get("rain_raw", 4095),
                "weight": weight_val, # Fixed mapping!
                "decision": command,
                "satellite_rain": upcoming_rain,
                "system_active": system_active 
            }
            table_client.create_entity(entity=entity)
            logging.info(f"✅ Data saved to Azure (Weight: {weight_val})")
        except Exception as db_err:
            logging.error(f"Failed to save to database: {db_err}")

    except Exception as e:
        logging.error(f"ERROR in Cloud Brain: {e}")

@app.route(route="SendCommand", auth_level=func.AuthLevel.ANONYMOUS)
def SendWebCommand(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"})
        
    try:
        req_body = req.get_json()
        command = req_body.get('command')
        device_id = req_body.get('device_id', 'esp32-weather')
        source = req_body.get('source', 'web')

        if command:
            send_c2d_command(device_id, command, source)
            global last_sent_command
            last_sent_command = command
            return func.HttpResponse(json.dumps({"status": "success", "message": f"Command '{command}' sent."}), mimetype="application/json", status_code=200, headers={"Access-Control-Allow-Origin": "*"})
        else:
            return func.HttpResponse(json.dumps({"status": "error", "message": "No command provided."}), status_code=400, headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        return func.HttpResponse(json.dumps({"status": "error", "message": str(e)}), status_code=500, headers={"Access-Control-Allow-Origin": "*"})

@app.route(route="GetSensorData", auth_level=func.AuthLevel.ANONYMOUS)
def GetSensorData(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"})
    
    try:
        db_conn_string = os.environ["AzureWebJobsStorage"]
        table_client = TableClient.from_connection_string(conn_str=db_conn_string, table_name="SensorData")
        
        entities = list(table_client.list_entities())
        entities.sort(key=lambda x: x['RowKey']) 
        latest_data = entities[-15:] 
        
        clean_data = []
        for e in latest_data:
            clean_data.append({
                "time": e.get("time", "00:00"),
                "temp": e.get("temp", 0),
                "humidity": e.get("humidity", 0),
                "light": e.get("light", 0),
                "rain": e.get("rain", 0),
                "weight": e.get("weight", 0),
                "decision": e.get("decision", "unknown"),
                "satellite_rain": e.get("satellite_rain", False),
                "system_active": e.get("system_active", True)
            })
            
        return func.HttpResponse(json.dumps(clean_data), mimetype="application/json", status_code=200, headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        logging.error(f"Error fetching data: {e}")
        return func.HttpResponse(json.dumps([]), mimetype="application/json", status_code=200, headers={"Access-Control-Allow-Origin": "*"})