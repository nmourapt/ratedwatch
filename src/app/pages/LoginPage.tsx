// Placeholder login screen. Better Auth wiring lands in a later slice
// (see PRD §auth). Slice 3 only needs this route to resolve + render
// the shared design language so the shell feels cohesive.
export function LoginPage() {
  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-4xl font-medium tracking-tight text-cf-text mb-4">
        Sign in
      </h1>
      <p className="text-cf-text-muted">
        Not implemented yet. The authed flow lands in an upcoming slice.
      </p>
    </section>
  );
}
