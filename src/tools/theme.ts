/**
 * Minimal Theme surface used by the render functions.
 *
 * This mirrors the runtime `Theme` class from `@earendil-works/pi-coding-agent`
 * (which exports `fg`, `bg`, `bold`, ...). We only depend on `fg` and `bold`,
 * so a structural interface keeps the renderers type-safe without importing
 * the class directly (importing it trips module-resolution in some setups).
 */
export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
