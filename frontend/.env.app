# Loaded by `vite build --mode app`, which is what `npm run build:app` runs. It is the difference
# between the bundle a taxis server serves and the bundle that goes inside the native app: see the
# note on `isNativeApp` in `src/server.ts` for why the packaged build says so at build time rather
# than relying only on detecting the native bridge at runtime.
VITE_TAXIS_PACKAGED=1
