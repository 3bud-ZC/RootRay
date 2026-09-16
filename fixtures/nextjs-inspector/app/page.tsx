import { ActionButton } from "../components/ActionButton";
import { Card } from "../components/Card";
import { StatusChip } from "../components/StatusChip";

export default function Page() {
  return (
    <main className="p-8">
      <Card title="Inspector fixture">
        <p className="text-slate-600">Next.js inspector coverage.</p>
        <ActionButton />
        <div className="mt-4 flex gap-2">
          <StatusChip label="alpha" />
          <StatusChip label="beta" />
          <StatusChip label="gamma" />
        </div>
      </Card>
    </main>
  );
}
