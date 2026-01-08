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
            Internal Use Only
          </h2>
          <p className="text-gray-600">
            AMY (Accounting Metrics & Yields) is an internal business tool used exclusively by
            MedRock Pharmacy employees. This application is not available to the public and does
            not collect, store, or process any customer or end-user data.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Data Usage
          </h2>
          <p className="text-gray-600">
            This application accesses financial and operational data from internal MedRock systems
            for reporting and analysis purposes. Access is restricted to authorized employees only.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            QuickBooks Integration
          </h2>
          <p className="text-gray-600">
            This application integrates with QuickBooks Online to retrieve financial data for
            internal reporting. All QuickBooks data access is authenticated and authorized through
            OAuth 2.0. No QuickBooks data is shared externally.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Security
          </h2>
          <p className="text-gray-600">
            Access to this application requires employee authentication. All data is stored securely
            and remains within MedRock&apos;s control. No data is shared with third parties.
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-6 mb-3">
            Contact
          </h2>
          <p className="text-gray-600">
            For questions or concerns, contact: <span className="text-purple-600">d.carson@medrockpharmacy.com</span>
          </p>
        </div>
      </div>
    </div>
  );
}
