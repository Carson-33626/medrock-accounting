// Public page - no authentication required (for QuickBooks app verification)
export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">
          Privacy Policy
        </h1>

        <div className="prose">
          <p className="text-gray-600 mb-4">
            <strong>Last Updated:</strong> January 8, 2026
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Internal Application
          </h2>
          <p className="text-gray-600">
            AMY (Accounting Metrics & Yields) is an internal application used exclusively by
            MedRock Pharmacy&apos;s accounting team. This application is not available to the public
            and does not collect data from external users or customers.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Collection & Usage
          </h2>
          <p className="text-gray-600 mb-2">
            This application processes the following types of data:
          </p>
          <ul className="list-disc list-inside text-gray-600 space-y-2">
            <li>Employee authentication data via MedRock&apos;s centralized auth system</li>
            <li>Financial data from MedRock&apos;s QuickBooks Online accounts</li>
            <li>Internal coupon redemption data</li>
            <li>Marketer profitability metrics</li>
            <li>Sales tax reporting data</li>
          </ul>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Storage
          </h2>
          <ul className="list-disc list-inside text-gray-600 space-y-2">
            <li>Data is stored securely in MedRock&apos;s Supabase instance</li>
            <li>QuickBooks OAuth tokens are encrypted and stored per location</li>
            <li>All data remains within MedRock&apos;s control</li>
            <li>No data is shared with third parties</li>
          </ul>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Security
          </h2>
          <ul className="list-disc list-inside text-gray-600 space-y-2">
            <li>Role-based access control (admin and super_admin roles)</li>
            <li>Session validation via encrypted cookies</li>
            <li>Middleware-level authentication checks</li>
            <li>Automatic OAuth token refresh for QuickBooks integration</li>
          </ul>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Third-Party Services
          </h2>
          <p className="text-gray-600">
            This application integrates with:
          </p>
          <ul className="list-disc list-inside text-gray-600 space-y-2">
            <li><strong>QuickBooks Online:</strong> For financial data retrieval (OAuth 2.0)</li>
            <li><strong>Supabase:</strong> For database and authentication</li>
            <li><strong>Vercel:</strong> For hosting</li>
          </ul>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Retention
          </h2>
          <p className="text-gray-600">
            Data is retained as needed for business operations and compliance purposes. Users
            can request data deletion by contacting the application administrator.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Contact Information
          </h2>
          <p className="text-gray-600">
            For privacy-related questions or concerns, contact:
            <br />
            <span className="text-purple-600">d.carson@medrockpharmacy.com</span>
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Changes to This Policy
          </h2>
          <p className="text-gray-600">
            This privacy policy may be updated as needed. Users will be notified of significant
            changes through the application or via email.
          </p>
        </div>
      </div>
    </div>
  );
}
