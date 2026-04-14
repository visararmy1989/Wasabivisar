import { ResumeRetriever } from '@/components/resume-retriever';

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="cloud cloud-one" />
        <div className="cloud cloud-two" />
        <div className="cloud cloud-three" />
        <div className="cloud-ring cloud-ring-one" />
        <div className="cloud-ring cloud-ring-two" />
      </div>
      <div className="wasabi-shell relative mx-auto flex w-full max-w-[1540px] flex-col gap-7 rounded-[2rem] px-3 py-3 sm:px-4 sm:py-4 md:px-5 md:py-5">
        <ResumeRetriever />
      </div>
    </main>
  );
}
