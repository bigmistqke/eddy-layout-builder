// Shared status + result reporting for experiments. An experiment emits
// exactly one [experiment-result] line; harness/run-cdp.mjs captures it,
// wraps it with git + timestamp metadata, and writes the experiment's
// result.json. The on-screen #status log (from the shared index.html
// shell) mirrors everything so a run can also be watched on the device.

const RESULT_PREFIX = "[experiment-result]"

function statusElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#status")
  if (element === null) {
    throw new Error("report: no #status element — is this running in the shell?")
  }
  return element
}

/** Append a progress line to the on-device status log and the console. */
export function status(line: string): void {
  statusElement().textContent += `${line}\n`
  console.log(`[experiment] ${line}`)
}

/**
 * Emit the final result. `params` is the experiment's input config —
 * recorded so the run is reproducible — and `result` is its measured
 * output. Device info is attached here so every experiment records it
 * uniformly. Call exactly once per run (including on the error path, so
 * the runner never has to wait out a timeout).
 */
export function reportResult(
  experiment: string,
  params: Record<string, unknown>,
  result: unknown,
): void {
  const payload = {
    experiment,
    params,
    device: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    result,
  }
  console.log(`${RESULT_PREFIX} ${JSON.stringify(payload)}`)
  statusElement().textContent += `\n${JSON.stringify(payload, null, 2)}\n`
}
