import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import type { PrinterSummary } from '@printhub/shared';
import { Button } from '../ui';
import { Modal } from '../Modal';
import { JobWizard } from '../slicing/JobWizard';

/** "Schnelldruck" button + dialog: the job wizard for this printer (models → bed → settings → review). */
export function QuickPrintButton({ printer }: { printer: PrinterSummary }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Zap className="size-4" /> Schnelldruck
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Schnelldruck auf ${printer.name}`} wide>
        <JobWizard
          fixedPrinter={printer.id}
          compact
          onFinish={(to) => {
            setOpen(false);
            if (to === 'jobs') navigate('/jobs');
          }}
        />
      </Modal>
    </>
  );
}
