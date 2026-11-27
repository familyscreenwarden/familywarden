import { Link } from 'react-router-dom';
import { useShell } from '../components/Layout';
import { Card, PageHead } from '../components/ui';

export function HelpPage() {
  const { billingEnabled } = useShell();
  return (
    <>
      <PageHead title="Help" sub="Short answers for getting set up." />
      <div className="grid-300">
        <Card title="Getting started">
          <ol className="steps">
            <li><Link to="/kids/new">Add a kid</Link> and set their daily time and bedtime.</li>
            <li><Link to="/devices?add=1">Add a device</Link>: a Windows PC gets a pairing code to type in, an Android phone gets a setup QR code to scan.</li>
            <li>Allow the apps and websites you are happy with under <Link to="/kids">Kids and rules</Link>.</li>
            <li>Set a parent PIN in <Link to="/settings">Settings</Link>.</li>
          </ol>
        </Card>
        <Card title="Which devices work">
          <p>Windows PCs and Android phones.</p>
          <p className="muted">Android setup needs a factory reset and a QR code, because the app is set up in device-owner mode. iPhone, iPad, Mac and Chromebook are not supported.</p>
        </Card>
        <Card title="How time is counted">
          <p className="muted">Time only counts while an app or website is open. The home screen and family calls are free. Apps you mark "Free, never counts" do not use up the daily time. Limits reset at midnight in your family's time zone.</p>
        </Card>
        <Card title="When a device is locked">
          <p className="muted">Family contacts can always be called or texted on the phone, and emergency calls always work. Kids can ask for more time or a new app, or do a chore you set up for extra time, and you answer under <Link to="/requests">Requests</Link>. "Pause all screens" on the dashboard locks every device until you resume.</p>
        </Card>
        {billingEnabled ? (
          <Card title="Trial and price">
            <p className="muted">The free trial lasts 30 days and needs no card. After that it is $4 a month or $36 a year per family, with unlimited kids and devices. If the trial ends without a plan, the console locks and device rules keep working with the last settings. See <Link to="/billing">Billing</Link>.</p>
          </Card>
        ) : (
          <Card title="Price">
            <p className="muted">Family Screen Warden is free to use right now, with unlimited kids and devices. No card is needed.</p>
          </Card>
        )}
        <Card title="Signing in">
          <p className="muted">There are no passwords. Type your email on the sign-in page and open the link we send. Each link works once and expires after 15 minutes.</p>
        </Card>
      </div>
    </>
  );
}
