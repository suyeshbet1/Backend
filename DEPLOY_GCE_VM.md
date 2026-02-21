# Deploy to Google Cloud VM (Compute Engine)

This project is an Express backend (`index.js`). It can authenticate to Firebase/Firestore in two ways:

- **Recommended on GCE**: Application Default Credentials (ADC) using the VM’s attached Service Account (no private key files).
- **Local/dev**: `.env` with `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.

## 1) VM requirements (recommended)

For a small/medium Node backend:

- **Machine type**: `e2-small` (2 vCPU, 2 GB RAM)
  - If traffic is very low: `e2-micro` can work, but 1 GB RAM can be tight with `node_modules`.
- **Boot disk**: 20–30 GB (SSD)
- **OS**: Ubuntu 22.04 LTS
- **Network**:
  - Allow inbound **TCP 80** and **TCP 443** (if using Nginx + HTTPS)
  - Optional: allow **TCP 4000** only if you want to expose Node directly (not recommended)
- **IP**: Reserve a **static external IP** if you want stable DNS

### If your traffic is heavy (important)

You mentioned **60–70 requests/second per user**. What matters for sizing is your **total peak requests/second** across all users and what each request does (Firestore reads/writes, Firebase Auth verify, heavy loops, etc.).

If you expect **hundreds to thousands of total RPS**, start with:

- **Recommended starting point**: `e2-standard-4` (4 vCPU, 16 GB RAM)
- If CPU becomes the bottleneck (lots of JSON + auth verification): `c3-standard-4` / `n2-standard-4`
- If you expect very high concurrency or burst traffic: `e2-standard-8` (8 vCPU, 32 GB RAM)

For production uptime, prefer **2+ VMs behind a Load Balancer** (Managed Instance Group) instead of a single VM.

## 2) Service Account (important)

Attach a Service Account to the VM with least-privilege access.

Minimum typical roles depend on what your routes do, but usually:

- Firestore access: `roles/datastore.user` (or more restrictive custom role)

If you also use Firebase Auth Admin SDK features:

- Firebase Auth admin: `roles/firebaseauth.admin`

Avoid creating/downloading private keys for production when possible.

## 2.1) Production security checklist (do this)

- Do **NOT** commit `.env` (this repo now ignores it).
- Use **ADC** on the VM (attach Service Account) instead of a JSON key.
- Restrict firewall: open only `80/443` to the world.
- Put Node behind Nginx and bind Node to localhost only (recommended).
- Set OS limits (open files) so the service can handle many connections.

## 3) Create the VM

In GCP Console:

1. Compute Engine → VM instances → Create instance
2. Select Ubuntu 22.04 LTS
3. Choose machine type (see above)
4. Attach the Service Account (above)
5. Firewall: allow HTTP/HTTPS

### Step-by-step (single VM, production-style)

1. Create VM with Ubuntu 22.04 LTS
2. Attach Service Account with required roles
3. Allow inbound `80/443` only
4. SSH → install Node + Nginx
5. Clone repo into `/opt/gback`
6. Install deps using `npm ci --omit=dev`
7. Create `/etc/gback.env` with `PORT=4000`
8. Install systemd unit and start it
9. Install Nginx reverse proxy and reload
10. Validate `/health` and your API routes

## 4) On the VM: install Node + git

SSH into the VM, then:

```bash
sudo apt-get update
sudo apt-get install -y git nginx

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v
npm -v

# (Recommended) basic hardening & limits for high concurrency
sudo tee /etc/security/limits.d/99-gback.conf > /dev/null <<'EOF'
www-data soft nofile 100000
www-data hard nofile 100000
EOF

sudo sysctl -w net.core.somaxconn=4096
sudo sysctl -w net.ipv4.ip_local_port_range="10240 65535"
```

## 5) Deploy code

Option A (clone from GitHub):

```bash
sudo mkdir -p /opt/gback
sudo chown $USER:$USER /opt/gback

cd /opt/gback
git clone <YOUR_REPO_URL> .

npm ci --omit=dev

# systemd service runs as www-data (default template)
sudo chown -R www-data:www-data /opt/gback
```

## 6) Environment variables

### Recommended on GCE (ADC)
Do **not** set `FIREBASE_*`.
Only set:

- `PORT=4000`

Create an env file (example):

```bash
sudo tee /etc/gback.env > /dev/null <<'EOF'
PORT=4000
EOF

sudo chmod 600 /etc/gback.env
```

## 7) Run as a systemd service

Copy the service file from `deploy/systemd/gback.service`:

```bash
sudo cp /opt/gback/deploy/systemd/gback.service /etc/systemd/system/gback.service
sudo systemctl daemon-reload
sudo systemctl enable --now gback
sudo systemctl status gback --no-pager
```

Logs:

```bash
journalctl -u gback -f
```

## 8) Nginx reverse proxy (recommended)

Copy config from `deploy/nginx/gback.conf`:

```bash
sudo cp /opt/gback/deploy/nginx/gback.conf /etc/nginx/sites-available/gback
sudo ln -sf /etc/nginx/sites-available/gback /etc/nginx/sites-enabled/gback
sudo nginx -t
sudo systemctl reload nginx
```

Now your API is reachable on port 80 at `/` (and your app listens internally on `127.0.0.1:4000`).

### Validate

On the VM:

```bash
curl -i http://127.0.0.1:4000/health
curl -i http://localhost/health

sudo systemctl status gback --no-pager
journalctl -u gback -n 200 --no-pager
```

## 8.1) If you need even more throughput

Single VM will eventually hit limits. The next production step is:

- Put the app in a **Managed Instance Group (MIG)** with **2+ instances**
- Put an **HTTP(S) Load Balancer** in front
- Use a health check hitting `/health`

This gives:

- Horizontal scaling
- Zero-downtime rolling updates
- No single point of failure

## 9) HTTPS (optional but recommended)

If you have a domain pointed to the VM IP:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx
```

## 10) Update / redeploy

```bash
cd /opt/gback
git pull
npm ci --omit=dev
sudo systemctl restart gback
```
