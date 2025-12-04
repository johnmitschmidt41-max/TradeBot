"""
Dashboard Logger - Captures all stdout/stderr and forwards to dashboard
"""
import os
import sys
import requests
import threading
from datetime import datetime

LOG_SERVER_URL = os.environ.get('LOG_SERVER_URL', 'http://localhost:3001')

def post_log_async(service, message, level='info'):
    """Post log to dashboard in background thread (non-blocking)"""
    def _post():
        try:
            requests.post(
                f'{LOG_SERVER_URL}/api/log',
                json={
                    'service': service,
                    'message': message,
                    'level': level,
                    'timestamp': datetime.now().isoformat()
                },
                timeout=0.5
            )
        except:
            pass
    
    try:
        thread = threading.Thread(target=_post, daemon=True)
        thread.start()
    except:
        _post()

class DashboardStream:
    """Stream wrapper that forwards logs to dashboard"""
    
    def __init__(self, original_stream, service_name, default_level='info'):
        self.original = original_stream
        self.service = service_name
        self.default_level = default_level
        self.buffer = ""
    
    def _detect_level(self, message):
        """Detect the actual log level from message content"""
        msg_lower = message.lower()
        
        # HTTP success codes (200, 201, 204) - these are INFO not ERROR
        if '" 200' in message or '" 201' in message or '" 204' in message:
            return 'info'
        
        # Common success patterns
        if any(x in message for x in ['Fetched', 'candles for', 'Running on', 'Serving Flask', 'Mode check']):
            return 'info'
        
        # Explicit error indicators
        if any(x in msg_lower for x in ['error', 'exception', 'traceback', 'failed', '❌']):
            return 'error'
        
        # Warning indicators
        if any(x in msg_lower for x in ['warning', 'warn', '⚠']):
            return 'warn'
        
        # HTTP error codes (4xx, 5xx)
        if '" 4' in message or '" 5' in message:
            return 'error'
        
        return self.default_level
    
    def write(self, message):
        """Write to terminal AND dashboard"""
        # Handle both str and bytes
        if isinstance(message, bytes):
            message = message.decode('utf-8', errors='replace')
        
        if message and message.strip() and message != '\n':
            # Write to terminal
            self.original.write(message)
            self.original.flush()
            
            # Send to dashboard (only non-empty lines)
            msg = message.strip()
            if msg:
                # Detect actual level from message content
                level = self._detect_level(msg)
                post_log_async(self.service, msg, level)
    
    def flush(self):
        self.original.flush()
    
    def isatty(self):
        return self.original.isatty()

def setup_logging(service_name):
    """Replace stdout/stderr with dashboard loggers"""
    sys.stdout = DashboardStream(sys.__stdout__, service_name, 'info')
    sys.stderr = DashboardStream(sys.__stderr__, service_name, 'error')

# Alias for convenience
setup_dashboard_logging = setup_logging
