# Vercel Log Drain -> Google Cloud Logging

Minimális Cloud Run service ami fogadja a Vercel log drain webhook-okat és továbbítja Google Cloud Logging-ba.

- Natív Node.js `http` modul (nincs express) -> gyors cold start, kis image
- Egyetlen dependency: `@google-cloud/logging`
- Pino structured log parsing
- HMAC signature verification

## Endpoints

| Method | Path | Leírás |
|--------|------|--------|
| GET | `/health` | Health check |
| POST | `/drain` | Log drain receiver |

### Query paraméterek (`/drain`)

| Param | Default | Leírás |
|-------|---------|--------|
| `app` | Vercel `projectName` | App név label a GCP-ben |
| `proxy` | `false` | `true` = HTTP request logok is továbbítódnak |

## Automatikus setup

Előfeltételek: `gcloud`, `gh` és `curl` CLI-k telepítve és bejelentkezve.

### 1. Változók beállítása

```bash
# GCP
export GCP_PROJECT_ID="gg3-nhost2"
export GCP_PROJECT_NUMBER=$(gcloud projects describe $GCP_PROJECT_ID --format='value(projectNumber)')
export GCP_REGION="europe-west1"
export SERVICE_ACCOUNT_NAME="logdrainer-deployer"
export SA_EMAIL="${SERVICE_ACCOUNT_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
export CLOUD_RUN_SA="logdrainer-runner@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
export WIF_POOL_ID="github-actions-pool"
export WIF_PROVIDER_ID="github-oidc-provider"

# GitHub
export GITHUB_REPO="your-org/logdrainer"

# Vercel
export VERCEL_TEAM_SLUG="your-vercel-team"
export VERCEL_TOKEN="your-vercel-api-token"  # https://vercel.com/account/tokens

# Log drain
export LOG_NAME="vercel-logs"
export WEBHOOK_SECRET=$(openssl rand -hex 32)
```

### 2. GCP APIs engedélyezése

```bash
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  containerregistry.googleapis.com \
  logging.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="${GCP_PROJECT_ID}"
```

### 3. GCP Service Account-ok

```bash
# Deploy service account (GitHub Actions használja)
gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
  --display-name="Log Drainer Deployer (GitHub Actions)" \
  --project="${GCP_PROJECT_ID}"

for ROLE in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/logging.admin \
  roles/iam.serviceAccountUser \
  roles/storage.admin; do
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${ROLE}"
done

# Cloud Run runtime service account (a service maga használja)
gcloud iam service-accounts create "logdrainer-runner" \
  --display-name="Log Drainer Runner" \
  --project="${GCP_PROJECT_ID}"

gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:${CLOUD_RUN_SA}" \
  --role="roles/logging.logWriter"
```

### 4. Workload Identity Federation (GitHub Actions -> GCP, key nélkül)

```bash
# Pool létrehozása
gcloud iam workload-identity-pools create "${WIF_POOL_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool" \
  --project="${GCP_PROJECT_ID}"

# GitHub OIDC provider
gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER_ID}" \
  --location="global" \
  --workload-identity-pool="${WIF_POOL_ID}" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == '$(echo $GITHUB_REPO | cut -d/ -f1)'" \
  --project="${GCP_PROJECT_ID}"

# Service account binding
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${GCP_PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_REPO}"
```

### 5. GitHub Secrets

```bash
export WIF_PROVIDER="projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"

gh secret set GCP_PROJECT_ID        --body "${GCP_PROJECT_ID}"   --repo "${GITHUB_REPO}"
gh secret set LOG_NAME              --body "${LOG_NAME}"          --repo "${GITHUB_REPO}"
gh secret set VERCEL_WEBHOOK_SECRET --body "${WEBHOOK_SECRET}"    --repo "${GITHUB_REPO}"
gh secret set WIF_PROVIDER          --body "${WIF_PROVIDER}"      --repo "${GITHUB_REPO}"
gh secret set WIF_SERVICE_ACCOUNT   --body "${SA_EMAIL}"          --repo "${GITHUB_REPO}"
gh secret set CLOUD_RUN_SERVICE_ACCOUNT --body "${CLOUD_RUN_SA}"  --repo "${GITHUB_REPO}"
```

### 6. Első deploy

```bash
git push origin main
# vagy manuálisan:
gh workflow run deploy.yml --repo "${GITHUB_REPO}"
```

### 7. Vercel Log Drain beállítása

A Cloud Run URL lekérdezése:

```bash
export DRAIN_URL=$(gcloud run services describe vercel-log-drain \
  --region="${GCP_REGION}" \
  --format='value(status.url)' \
  --project="${GCP_PROJECT_ID}")
echo "Drain URL: ${DRAIN_URL}/drain"
```

Log drain létrehozása (a Vercel CLI-nek nincs log-drain parancsa, REST API-t kell használni):

```bash
curl -X POST "https://api.vercel.com/v1/drains?slug=${VERCEL_TEAM_SLUG}" \
  -H "Authorization: Bearer ${VERCEL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "gcp-log-drain",
    "projects": "all",
    "schemas": { "log": { "version": "v1" } },
    "delivery": {
      "type": "http",
      "endpoint": "'"${DRAIN_URL}/drain"'",
      "encoding": "ndjson",
      "compression": "gzip",
      "headers": {},
      "secret": "'"${WEBHOOK_SECRET}"'"
    },
    "filter": {
      "version": "v2",
      "filter": {
        "type": "basic",
        "log": {
          "sources": ["build", "edge", "lambda", "static", "external"]
        },
        "deployment": {
          "environments": ["production", "preview"]
        }
      }
    }
  }'
```

### 8. Tesztelés

```bash
# Health check
curl "${DRAIN_URL}/health"

# Logok megtekintése
gcloud logging read "logName=projects/${GCP_PROJECT_ID}/logs/${LOG_NAME}" --limit 10
```

## Költségek

- Scale to zero: csak akkor fizetsz amikor jönnek logok
- Becsült havi költség: ~$0
