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

## 2) Service Account (important)

Attach a Service Account to the VM with least-privilege access.

Minimum typical roles depend on what your routes do, but usually:

- Firestore access: `roles/datastore.user` (or more restrictive custom role)

If you also use Firebase Auth Admin SDK features:

- Firebase Auth admin: `roles/firebaseauth.admin`

Avoid creating/downloading private keys for production when possible.

## 3) Create the VM

In GCP Console:

1. Compute Engine → VM instances → Create instance
2. Select Ubuntu 22.04 LTS
3. Choose machine type (see above)
4. Attach the Service Account (above)
5. Firewall: allow HTTP/HTTPS

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
