
const fetch = global.fetch;

async function testSearch() {
    try {
        const res = await fetch('http://localhost:3000/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'cricket updates' })
        });

        if (!res.ok) throw new Error(`Status: ${res.status}`);

        const data = await res.json();
        console.log("--- SEARCH RESULTS ---");
        console.log("Summary Length:", data.summary?.length);
        console.log("Articles Found:", data.articles?.length);

        if (data.articles) {
            console.log("Sources found:");
            data.articles.forEach(a => console.log(`- ${a.source}: ${a.title}`));
        }

        console.log("\n--- AI SUMMARY ---");
        console.log(data.summary);

    } catch (error) {
        console.error("Search Test Failed:", error);
    }
}

testSearch();
