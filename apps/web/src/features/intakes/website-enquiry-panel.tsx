import { Card, CardHeader } from '../../components/ui';
import { useLeadSourceIntake } from './use-intakes';

/**
 * The enquiry this lead came from, in the customer's own words.
 *
 * Renders nothing at all for a lead somebody created by hand — an empty
 * "Website enquiry: none" panel on every manual lead would be clutter on the
 * screen a salesperson looks at most.
 *
 * The message is read through the intake relation rather than copied onto the
 * lead: one source record, four thousand characters, and one place to redact
 * it if the customer ever asks.
 */
export function WebsiteEnquiryPanel({ leadId }: { leadId: string }): React.JSX.Element | null {
  const intake = useLeadSourceIntake(leadId);

  // Quiet on both failure and absence. This is supporting context beside the
  // lead, and an error box here would suggest the lead itself was broken.
  if (intake.isPending || intake.isError || !intake.data) return null;

  const enquiry = intake.data;

  return (
    <Card>
      <CardHeader
        title="Website enquiry"
        subtitle={`Arrived ${new Date(enquiry.receivedAt).toLocaleString()}`}
      />

      <div className="space-y-3 px-5 py-4 text-sm">
        {enquiry.message && (
          <p className="whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-slate-800">
            {enquiry.message}
          </p>
        )}

        {enquiry.productInterest && (
          <p className="text-slate-700">
            <span className="text-xs text-slate-500">Asked about</span>
            <br />
            {enquiry.productInterest}
          </p>
        )}

        {enquiry.sourcePage && (
          <p className="text-xs text-slate-500">From {enquiry.sourcePage}</p>
        )}

        {(enquiry.rule || enquiry.team || enquiry.territory) && (
          // Why it reached this person, in one line. A rep asking "why me?"
          // should not have to open an operations screen to find out.
          <p className="text-xs text-slate-500">
            Routed by{' '}
            {[enquiry.rule?.name, enquiry.territory?.name, enquiry.team?.name]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </div>
    </Card>
  );
}
