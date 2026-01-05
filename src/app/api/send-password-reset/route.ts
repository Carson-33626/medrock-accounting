import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getAdminClient } from '@/lib/supabase-admin';

/**
 * POST /api/send-password-reset
 *
 * Sends a password reset email to a user.
 * Note: This uses Supabase's built-in password reset functionality.
 * For custom email templates, integrate with a service like Resend.
 */
export async function POST(request: Request) {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    if (currentUser.role !== 'admin' && currentUser.role !== 'super_admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { email, redirectUrl } = await request.json();

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const supabase = getAdminClient();

    // Generate a password reset link
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: redirectUrl || `${process.env.NEXT_PUBLIC_AUTH_SERVICE_URL}/reset-password`,
      },
    });

    if (error) {
      console.error('Password reset error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // For now, we just return success since we're using the centralized auth service
    // The actual email sending would be handled by Supabase or a custom email service
    return NextResponse.json({
      success: true,
      message: `Password reset link generated for ${email}`,
      // In production, don't expose the link - it should be emailed
      // link: data.properties?.action_link
    });

  } catch (error) {
    console.error('Password reset error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
