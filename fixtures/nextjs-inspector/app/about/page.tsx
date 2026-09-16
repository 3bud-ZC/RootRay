import Link from "next/link";

export default function AboutPage() {
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">About RootRay</h1>
      <p className="mt-2">Second route for navigation inspection.</p>
      <Link href="/" className="text-blue-600 underline">
        Back home
      </Link>
    </main>
  );
}
