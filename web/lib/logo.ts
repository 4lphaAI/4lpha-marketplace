/**
 * Ported from the Claude Design export (ui_kits/marketplace/logo-data.js).
 *
 * The export inlined the mark as a base64 PNG on `window.LOGO_MARK`. The same
 * bytes now live at `public/design/logo-mark.png`, so the src is a normal URL
 * and the 21 KB base64 blob stays out of the JS bundle. Nothing in the design
 * measured the string itself — only `LOGO_MARK_SRC` was ever consumed.
 */
export const LOGO_MARK_SRC = "/design/logo-mark.png";
