import { redirect } from 'next/navigation';

// Old flat route — FL is now the MedRock Florida entity's FL return.
export default function LegacyFlRedirect() {
  redirect('/sales-tax/florida/fl');
}
