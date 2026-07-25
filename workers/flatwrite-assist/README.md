# flatwrite-assist Worker

Morph-powered document assist for FlatWrite.

See [docs/MORPH-ASSIST.md](../../docs/MORPH-ASSIST.md) for API, auth, deploy, and UI details.

```bash
# secrets
npx wrangler secret put API_KEY
npx wrangler secret put MORPH_API_KEY

# deploy
npx wrangler deploy
```

Local:

```bash
npx wrangler dev
# then POST http://127.0.0.1:8787/assist with X-Api-Key
```
