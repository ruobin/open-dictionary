# Chrome Extension — Dev Signing Key

`dev-key.pem` (this directory) is the **private** half of the RSA keypair
whose public half is pinned in `manifest.json`'s `"key"` field. It is
**gitignored** (`.gitignore`: `extension/*.pem`) and must never be committed —
see design-browser-extension.md §13.1 for why the key is pinned at all
(stable extension ID across reloads, so `ALLOWED_ORIGINS` doesn't need to
change every time the extension is reloaded unpacked during development).

**You do not need this file to build or load the extension.** Chrome derives
the extension's ID from the `"key"` field already embedded in
`manifest.json`, not from `dev-key.pem` itself — the `.pem` only exists so
the key can be regenerated/rotated if ever needed. Nothing in the build or
runtime reads this file.

## Regenerating the key pair (only if rotating)

```bash
openssl genrsa -out dev-key.pem 2048
openssl rsa -in dev-key.pem -pubout -outform DER -out /tmp/key.pub.der
base64 -i /tmp/key.pub.der | tr -d '\n'
```

Paste the resulting base64 string into `manifest.json`'s `"key"` field. The
extension's new ID (which must then be re-added to `ALLOWED_ORIGINS` in
`server/.env`) can be computed as:

```bash
python3 -c "
import hashlib
with open('/tmp/key.pub.der', 'rb') as f:
    der = f.read()
h = hashlib.sha256(der).hexdigest()[:32]
print(h.translate(str.maketrans('0123456789abcdef', 'abcdefghijklmnop')))
"
```

Current pinned dev extension ID: `mliclnamclidbemdcahklcdoikncablf`
