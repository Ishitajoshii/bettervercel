import Link from 'next/link';
export default function About() {
  return <main><h1>Nested route works</h1><p>This page is exported as about/index.html.</p><Link href="/">Back to home</Link></main>;
}
