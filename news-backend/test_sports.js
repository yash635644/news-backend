// Using global fetch (Node 18+)

async function testSports() {
    try {
        console.log("Testing search with 'T20 World Cup'...");
        const response = await fetch('http://localhost:3000/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'T20 World Cup Cricket' })
        });

        const data = await response.json();
        console.log('--- AI SUMMARY ---');
        console.log(data.summary);
        console.log('------------------');
        console.log('Articles Found:', data.articles.length);

    } catch (error) {
        console.error('Fetch Error:', error);
    }
}

testSports();
