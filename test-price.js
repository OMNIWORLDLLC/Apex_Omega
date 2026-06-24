async function test() {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const data = await res.json();
  console.log(data);
}
test();
