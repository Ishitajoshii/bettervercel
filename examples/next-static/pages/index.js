import Link from 'next/link';
import { useState } from 'react';
export default function Home() {
  const [count, setCount] = useState(0);
  return <main><h1>Next.js on Better Vercel</h1><p>A real static export beneath an immutable preview path.</p>
    <button onClick={() => setCount(count + 1)}>Clicks: {count}</button><p><Link href="/about/">About this preview</Link></p></main>;
}
