const URL = "http://localhost:3000/api/health";

async function verify() {
  console.log("Verifying /api/health endpoint...\n");

  let res;
  try {
    res = await fetch(URL);
  } catch (err) {
    console.error(`FAIL: Could not reach ${URL} -- is the dev server running? Error: ${err.message}`);
    process.exit(1);
  }

  if (res.status !== 200) {
    console.error(`FAIL: Expected status 200, got ${res.status}`);
    process.exit(1);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    console.error(`FAIL: Expected Content-Type to include application/json, got "${contentType}"`);
    process.exit(1);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`FAIL: Could not parse JSON body. Error: ${err.message}`);
    process.exit(1);
  }

  if (!body || body.status !== "ok") {
    console.error(`FAIL: Expected body { status: "ok" }, got ${JSON.stringify(body)}`);
    process.exit(1);
  }

  console.log('PASS: /api/health returned 200 {status:"ok"}');
  process.exit(0);
}

verify().catch((err) => {
  console.error(`FAIL: Unexpected error: ${err.message}`);
  process.exit(1);
});
