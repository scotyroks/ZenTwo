# ZenTwo — Photon Garden

An interactive 2D spectral raytracer in the spirit of
[zenphoton.com](https://zenphoton.com/). Place a light, draw walls of
different materials, and watch millions of photons accumulate into a
long-exposure image of the light field.

## Running

Web Workers can't load over `file://`, so serve the directory:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Controls

- **Light** — click or drag to move the source
- **Diffuse / Mirror / Glass** — drag to draw a wall segment
- **Erase** — click near a segment to remove it
- Exposure slider, Undo (`⌘Z`), Redo (`⌘⇧Z`), Clear, Save PNG

## Physics

The simulation is a spectral Monte Carlo light tracer. Per photon:

- **Spectral emission** — each photon carries one wavelength, sampled by
  inverse CDF from a 6500 K Planck (blackbody) spectrum over 380–730 nm.
  Its color weight comes from the CIE 1931 color matching functions
  (Wyman–Sloan–Shirley analytic fits, JCGT 2013), converted to linear sRGB
  and white-balanced so the full spectrum sums to neutral white.
  Out-of-gamut spectral colors are kept (negative components) until display.
- **Dispersion** — glass is SCHOTT N-BK7; the refractive index per
  wavelength comes from the Sellmeier equation, so prisms produce
  physically correct rainbows.
- **Fresnel with polarization** — glass interfaces use the exact dielectric
  Fresnel equations. In 2D the plane of incidence is the simulation plane,
  so each photon's s/p polarization state is tracked exactly and compounds
  across interfaces — Brewster-angle transmission is real. Total internal
  reflection falls out of the same math. Refraction tracks inside/outside
  state, so closed glass shapes behave like solid objects.
- **Materials** — diffuse walls are Lambertian (cosine-weighted in 2D)
  with 0.85 albedo (matte white paint); mirrors reflect 92 % (aluminum,
  visible-band average) and preserve polarization.
- **Unbiased termination** — Russian roulette instead of a bounce cap, so
  multi-bounce energy in mirror rooms is not truncated (a 500-bounce safety
  cap remains; the probability of reaching it is < 1e-18).
- **Open world** — rays are traced in the unbounded plane. Light that
  leaves the viewport keeps interacting with geometry and can re-enter;
  only the visible portion of each path is deposited.
- **Energy-exact rasterization** — paths deposit via Amanatides–Woo grid
  traversal: every pixel receives energy proportional to the exact path
  length crossing it, eliminating the direction-dependent brightness bias
  of stepped line drawing.
- **Display** — per-channel film response `1 − exp(−k·E)` (photon-counting
  saturation), normalized by rays traced, then the exact piecewise sRGB
  transfer function. Exposure is in stops.
- **Convergence** — emission angles follow a golden-ratio low-discrepancy
  sequence (randomly rotated per scene) for faster, smoother convergence.

Not modeled: wave effects (interference, diffraction), spectral metal
reflectance, participating media, and the third dimension. The image is the
path density of the 2D light field — equivalent to photographing the plane
from above in a uniformly scattering medium.

## Testing

```sh
node test/smoke.js
```

Runs the worker headlessly and asserts (1) an empty scene renders neutral
white — validating the spectral pipeline end to end — and (2) a
slit-collimated beam through a prism disperses, with blue deviated further
than red.

## Architecture

- `worker.js` — the tracer. Owns a `Float32Array` RGB accumulator, traces
  in ~14 ms slices (scheduled via `MessageChannel` to dodge `setTimeout`
  clamping), tone-maps to RGBA at ~16 fps, and posts frames as transferable
  buffers. Buffers are ping-ponged back from the main thread, so steady
  state allocates nothing.
- `main.js` — UI only: scene editing, undo/redo, overlay drawing,
  `putImageData` of finished frames. Scene edits re-send geometry and reset
  accumulation; drags stream throttled previews for live feedback.
