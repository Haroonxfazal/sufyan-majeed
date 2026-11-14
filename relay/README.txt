ZKTECO RELAY - SETUP GUIDE
==========================
Why: the MB460 can only be pointed at an IP address (it will not accept letters), but the
website is reached by name. This tiny free cloud server has a fixed IP, accepts the machine's
requests and forwards only /iclock/* to the website. No PC or server at the academy.

  MB460 --(HTTP, port 80)--> relay VM (fixed IP) --(HTTPS)--> unique-academy Worker --> Supabase


STEP 1 - CREATE THE FREE VM (pick one)
--------------------------------------
Oracle Cloud "Always Free":
  - Create a Compute instance, image Ubuntu 22.04/24.04, shape VM.Standard.E2.1.Micro
    (or the free Ampere A1). Keep the default public IP.
  - Networking -> your VCN -> Security List -> Add Ingress Rule:
        Source 0.0.0.0/0, TCP, destination port 80.
  - Download the SSH key when asked.
Google Cloud "Free Tier":
  - Compute Engine -> e2-micro in us-west1 / us-central1 / us-east1, Ubuntu.
  - Tick "Allow HTTP traffic". (Reserve a STATIC external IP so it never changes:
    VPC network -> IP addresses -> Reserve.)

STEP 2 - INSTALL THE RELAY (on the VM, over SSH)
------------------------------------------------
    curl -fsSL https://raw.githubusercontent.com/Haroonxfazal/sufyan-majeed/main/relay/setup.sh | sudo bash

It installs nginx, applies relay/nginx-iclock.conf and prints the VM's public IP.
Check it:   curl -i 'http://<VM-IP>/iclock/getrequest?SN=TEST'
Expect:     HTTP 403 "Unknown device"   (that means relay -> website works)

STEP 3 - POINT THE MACHINE AT THE RELAY
---------------------------------------
Ethernet cable from the MB460 to the main router, then on the machine:
  Menu -> Comm. -> Ethernet : DHCP (or a free IP), gateway = router, DNS 8.8.8.8
  Menu -> Comm. -> Cloud Server Setting :
        Server Mode   ADMS
        Server Address <VM public IP>      (digits only is fine)
        Server Port    80
        HTTPS          off
  Save and restart the machine.

STEP 4 - CHECK
--------------
Put a finger on the machine. The punch shows on the website's Attendance page within
seconds, and the Dashboard "Academy Connection" card turns green.

NOTES
-----
- Only /iclock/* is forwarded; everything else returns 404.
- The website only accepts machines whose serial number is in the devices table
  (AF6P210960179), so other traffic is rejected.
- If the VM's IP ever changes, update Server Address on the machine (use a static IP to avoid it).
- The old PC agent can stay off. If both ever run, duplicate punches are ignored.
