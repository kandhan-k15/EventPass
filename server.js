const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("EventPass is running");
});

app.listen(3000, () => console.log("Server on http://localhost:3000"));