/**
 * Provider-side constrained decoding for tool arguments (pi 0.84+).
 *
 * pi's built-in tools set `constrainedSampling: { type: "json_schema",
 * strict: "prefer" }` when `PI_EXPERIMENTAL=1` (see pi's
 * `getExperimentalToolSampling()`); older pi hosts never read the field, so
 * setting it unconditionally here is version-tolerant. `strict: "prefer"`
 * degrades gracefully on providers without structured-output support.
 *
 * The payload targets the exact failure class our teaching errors patch:
 * models echoing rendered output into arguments, stringifying arrays, or
 * inventing field names. With constrained decoding the provider's grammar
 * makes those malformed calls structurally impossible instead of rejected
 * after the fact.
 */
export function experimentalToolSampling(): { type: "json_schema"; strict: "prefer" } | undefined {
  return process.env.PI_EXPERIMENTAL === "1"
    ? { type: "json_schema", strict: "prefer" }
    : undefined;
}
