import { redirect } from 'next/navigation';

// Old flat route — TX is now filed by two entities. Default to the MedRock Texas return.
export default function LegacyTxRedirect() {
  redirect('/sales-tax/texas/tx');
}
