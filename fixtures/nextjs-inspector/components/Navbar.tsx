import Link from "next/link";

export function Navbar() {
  return (
    <nav className="flex gap-4 border-b p-4">
      <span className="font-bold">RootRay Next</span>
      <Link href="/" className="text-blue-600">
        Home
      </Link>
      <Link href="/about" className="text-blue-600">
        About
      </Link>
    </nav>
  );
}
