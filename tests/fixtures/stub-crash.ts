// A "lab" that dies on startup — used to prove launch failures are detected
// immediately and reported with the real reason.
console.error("boom: simulated startup failure");
process.exit(3);
