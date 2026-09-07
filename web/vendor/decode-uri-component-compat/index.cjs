// query-string 7 expects require() to return a function. The fixed upstream
// decoder is ESM; Node 22.12+ and our bundlers expose its default export here.
module.exports = require("decode-uri-component-patched").default;
