// Plain Node project — no Vite, no React. RootRay must report it as
// unsupported with factual reasons rather than crashing.
const http = require("node:http");

const server = http.createServer((_req, res) => {
  res.end("unsupported fixture");
});

server.listen(0);
