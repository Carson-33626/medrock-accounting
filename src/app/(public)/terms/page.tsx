// Public page - no authentication required (for QuickBooks app verification)
export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white p-8">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-6">
          End-User License Agreement
        </h1>

        <div className="prose">
          <p className="text-gray-600 mb-4">
            <strong>Last Updated:</strong> January 8, 2026
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Internal Use Only
          </h2>
          <p className="text-gray-600">
            This application (AMY - Accounting Metrics & Yields) is an internal tool developed
            exclusively for use by MedRock Pharmacy employees and authorized personnel.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Purpose
          </h2>
          <p className="text-gray-600">
            AMY provides accounting analytics, financial reporting, and QuickBooks integration
            for MedRock&apos;s accounting team.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Access & Authorization
          </h2>
          <ul className="list-disc list-inside text-gray-600 space-y-2">
            <li>Access is restricted to authorized MedRock employees only</li>
            <li>Users must authenticate through MedRock&apos;s centralized auth system</li>
            <li>Admin features require additional role-based permissions</li>
            <li>Unauthorized access or misuse is prohibited</li>
          </ul>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Usage
          </h2>
          <p className="text-gray-600">
            This application accesses MedRock&apos;s QuickBooks Online accounts to retrieve financial
            data for internal reporting and analysis purposes only.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Contact
          </h2>
          <p className="text-gray-600">
            For questions or support, contact: <span className="text-purple-600">d.carson@medrockpharmacy.com</span>
          </p>
        </div>
      </div>
    </div>
  );
}
