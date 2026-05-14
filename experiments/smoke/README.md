# smoke

**Question:** will the device hand us a camera + mic stream at all?

Not a real finding — a ~5-second harness check. Run it first whenever the
on-device setup is in doubt (Chrome socket vs Brave, OS permissions,
per-site grant, foreground tab). It calls `getUserMedia`, reports `ok`
with the negotiated resolution or `denied` with the error name, and exits.

If smoke is green, a real experiment will get a camera too.

## Reproduce

```sh
pnpm dev
PORT=<port> experiments/harness/run.sh smoke
```
