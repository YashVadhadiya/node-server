const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.end("Server is running 24/7 from cloud!");
  }).listen(PORT, () => {
    console.log("Server running on port " + PORT);
    });