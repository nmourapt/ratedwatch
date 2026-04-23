// Server-rendered landing page. Slice 1 is deliberately minimal — it exists
// so the walking-skeleton integration test can prove the Worker + Hono + JSX
// toolchain is wired up correctly. Real design lands in a later slice.
export const LandingPage = () => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>rated.watch — coming soon</title>
      <meta
        name="description"
        content="Competitive accuracy tracking for watch enthusiasts."
      />
    </head>
    <body>
      <main>
        <h1>rated.watch</h1>
        <p>Competitive accuracy tracking for watch enthusiasts — coming soon.</p>
      </main>
    </body>
  </html>
);
