ATTENDANCE AGENT ON THE RELAY VM (no PC at the academy)
=======================================================
The MB460 firmware never uploads punches through its cloud (ADMS) mode, so the VM reads
the machine directly with the normal agent (device-service/agent.py) over the internet.

Needs on the academy router: port forward TCP 4370 -> 192.168.100.13:4370
(allow only the VM's IP 161.118.179.2 if the router supports it) and a fixed IP for the machine.

Installed on the VM:
  /opt/zk-agent/agent.py            copy of device-service/agent.py
  /opt/zk-agent/agent.env           settings incl. service key (chmod 600) - see agent.env.example
  /opt/zk-agent/run-agent.sh        finds the academy's current public IP from the machine's
                                    relay heartbeat, then starts the agent
  /etc/systemd/system/zk-agent.service
  /etc/cron.d/zk-agent-ipwatch      restarts the agent if the academy IP changes
  VM timezone = Asia/Karachi        (the agent sets the machine clock from the VM clock)

Start once the port forward works:
  sudo systemctl enable --now zk-agent
  journalctl -u zk-agent -f
