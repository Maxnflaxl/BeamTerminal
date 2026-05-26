import React from 'react';
import { styled } from '@linaria/react';

const Page = styled.div`
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px 48px;
  color: rgba(255, 255, 255, 0.85);
  font-family: 'SFProDisplay', monospace;
  font-size: 14px;
  line-height: 1.6;

  h1 {
    font-size: 22px;
    margin: 0 0 8px;
    color: white;
  }
  h2 {
    font-size: 15px;
    margin: 28px 0 8px;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  p { margin: 0 0 12px; }
  ul { margin: 0 0 12px; padding-left: 20px; }
  li { margin: 4px 0; }
  a { color: #00f6d2; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ${'\'SFProDisplay\', monospace'}; color: #00f6d2; background: rgba(0,246,210,0.08); padding: 1px 5px; border-radius: 3px; }
`;

const Updated = styled.div`
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
  margin-bottom: 16px;
`;

export const Privacy: React.FC = () => (
  <Page>
    <h1>Privacy Policy</h1>
    <Updated>Last updated: 2026-05-26</Updated>

    <p>
      BeamTerminal is a block-explorer and DEX analytics front-end for
      the Beam network, operated under <strong>0xmx.net</strong>{' '}
      (&ldquo;we&rdquo;, &ldquo;us&rdquo;). This policy explains what
      data we process when you visit beamterminal.0xmx.net or any other
      site we host under 0xmx.net.
    </p>

    <h2>What we collect</h2>
    <p>
      <strong>Web-server access logs</strong> — your IP address, request
      timestamp, requested URL, HTTP status, response size, referrer, and
      user-agent. These come from nginx and are used for operational
      diagnostics and abuse mitigation.
    </p>

    <h2>What we do not collect</h2>
    <ul>
      <li>No accounts, no sign-up, no email collection at the site level.</li>
      <li>No tracking cookies, no advertising pixels, no third-party analytics.</li>
      <li>No fingerprinting beyond what nginx logs by default.</li>
      <li>UI prefs (timeframe, log toggle, column order) sit in your browser&apos;s <code>localStorage</code> and never leave your device.</li>
    </ul>

    <h2>Third parties in the request path</h2>
    <ul>
      <li>
        <strong>Cloudflare</strong> sits in front of the site for TLS
        termination, DDoS protection, and edge caching. Cloudflare therefore
        sees your IP address and request metadata. See{' '}
        <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">
          Cloudflare&apos;s privacy policy
        </a>.
      </li>
      <li>
        <strong>Beam explorer node</strong> — our backend queries a public
        Beam node on the server side. Your browser does not connect to it
        directly.
      </li>
      <li>
        <strong>External links</strong> — clicking links to GitHub, X /
        Twitter, Telegram, Discord, beam.mw, etc. takes you to those
        services, which have their own privacy policies.
      </li>
    </ul>

    <h2>How we use the data</h2>
    <p>
      Access logs are only used to keep the service running: diagnose
      errors, investigate abuse (e.g. scraping or denial-of-service), and
      tune capacity. We do not profile visitors, sell logs, or share them
      with advertisers. We do not aggregate logs into reports beyond what
      a sysadmin needs.
    </p>

    <h2>Data retention</h2>
    <p>
      nginx access logs are rotated daily and kept for 14 days.
    </p>

    <h2>Your rights</h2>
    <p>
      If you are in the EU/EEA you have rights under the GDPR (access,
      erasure, restriction, etc.). Because the only personal data we hold
      is your IP address inside ephemeral server logs, the typical exercise
      of those rights is asking us to delete log lines containing your IP.
      Email <a href="mailto:me@maxnflaxl.dev">me@maxnflaxl.dev</a> with
      enough detail (approximate date/time window and the relevant IP) and
      we&apos;ll handle it.
    </p>

    <h2>Changes to this policy</h2>
    <p>
      We&apos;ll update this page if the data we process materially
      changes. The &ldquo;Last updated&rdquo; date at the top of the page
      always reflects the current revision.
    </p>

    <h2>Contact</h2>
    <p>
      For anything privacy-related, email{' '}
      <a href="mailto:me@maxnflaxl.dev">me@maxnflaxl.dev</a> or message{' '}
      <a href="https://t.me/maxnflaxl" target="_blank" rel="noopener noreferrer">@maxnflaxl</a> on Telegram.
    </p>
  </Page>
);

export default Privacy;
