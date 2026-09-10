"""Linux user-service definitions; no commands run at import time."""



def unit(description, command, directory, environment, service_path):
    return f"""[Unit]
Description={description}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=HOME=%h
Environment=PATH={service_path}
Environment=NODE_ENV=production
EnvironmentFile={environment}
WorkingDirectory={directory}
ExecStart={command}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
Nice=5
CPUWeight=50

[Install]
WantedBy=default.target
"""
