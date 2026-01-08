# Development Mode Guide

## Testing QuickBooks Connection Locally

When testing the QuickBooks integration in sandbox mode on your local machine, you can skip the authentication requirement by enabling development mode.

### Setup

1. **Enable Dev Mode** - Your [.env.local](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.local) already has this enabled:
   ```env
   DEV_SKIP_AUTH=true
   ```

2. **QuickBooks Sandbox Configuration** - Already configured in [.env.local](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.local):
   ```env
   QUICKBOOKS_CLIENT_ID=ABSn6TLQckfN5J1jxxayMTgzBfxZSoMMXvvKGL0488jKy4raKq
   QUICKBOOKS_CLIENT_SECRET=mPNaWl2kTfyS5ZahOTCdOTOgrr7bOxSXd4m6gXrL
   QUICKBOOKS_REDIRECT_URI=http://localhost:3000/api/quickbooks/callback
   QUICKBOOKS_ENVIRONMENT=sandbox
   ```

### Running Locally

1. **Start the development server**:
   ```bash
   cd web
   npm run dev
   ```

2. **Access the app** - You'll see a warning in the console:
   ```
   ⚠️  DEV MODE: Authentication is DISABLED. This should only be used for local testing!
   ```

3. **Test QuickBooks Connection**:
   - Navigate to: `http://localhost:3000/admin/quickbooks`
   - Click "Connect to QuickBooks" for any location (FL, TN, or TX)
   - You'll be redirected to QuickBooks Sandbox for authorization
   - After authorizing, you'll be redirected back to your local app
   - The OAuth callback will save tokens to Supabase

### What Dev Mode Does

When `DEV_SKIP_AUTH=true`:

1. **Middleware** bypasses all authentication checks
2. **getCurrentUser()** and **`/api/auth/me`** return a mock super_admin user:
   ```javascript
   {
     id: 'dev-user-12345',
     email: 'dev@medrockpharmacy.com',
     first_name: 'Dev',
     last_name: 'User',
     full_name: 'Dev User',
     role: 'super_admin',
     regions: [],
     departments: []
   }
   ```
3. **All routes** are accessible without login
4. **Admin pages** (like `/admin/quickbooks`) work without role checks
5. **Client-side auth** (`useAuth()` hook) receives the mock user

### Testing the QuickBooks Integration

Once you've connected QuickBooks in sandbox mode:

1. **Check Connection Status**:
   ```bash
   curl http://localhost:3000/api/quickbooks/status
   ```

2. **Test Connection**:
   ```bash
   curl http://localhost:3000/api/quickbooks/test-connection?location=MedRock%20FL
   ```

3. **Fetch Revenue Data**:
   ```bash
   curl "http://localhost:3000/api/quickbooks/revenue?location=MedRock%20FL&startDate=2025-01-01&endDate=2025-12-31&granularity=monthly"
   ```

### Important Security Notes

⚠️ **NEVER enable DEV_SKIP_AUTH in production!**

- This completely disables authentication
- Anyone can access admin pages and sensitive data
- Only use this in your local development environment
- The environment variable is NOT included in [.env.vercel](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.vercel), so production deployments remain secure

### Disabling Dev Mode

To test with real authentication:

1. Set `DEV_SKIP_AUTH=false` in [.env.local](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.local)
2. Or comment it out: `# DEV_SKIP_AUTH=true`
3. Restart the dev server
4. You'll need to authenticate via the centralized auth service

### QuickBooks Sandbox Notes

- **Sandbox companies**: You can create test companies at [developer.intuit.com](https://developer.intuit.com)
- **Test data**: Sandbox companies come with sample transactions
- **Multiple locations**: You can connect different QB sandbox companies to each location (FL, TN, TX)
- **Token storage**: Tokens are stored in Supabase `amy_quickbooks_tokens` table
- **Token refresh**: Access tokens expire every 60 minutes but are auto-refreshed

### Troubleshooting

**OAuth redirect fails**:
- Verify `QUICKBOOKS_REDIRECT_URI` is exactly `http://localhost:3000/api/quickbooks/callback`
- Check that this URL is added in your QuickBooks app settings at developer.intuit.com

**"Not connected" errors**:
- Check that tokens are saved in Supabase `amy_quickbooks_tokens` table
- Verify location name is exact: `MedRock FL`, `MedRock TN`, or `MedRock TX`

**Supabase connection errors**:
- Ensure `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set
- Check database has `amy_quickbooks_tokens` table (run migration if needed)

### Switching to Production

When ready to test with production QuickBooks:

1. Update [.env.local](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.local):
   ```env
   QUICKBOOKS_ENVIRONMENT=production
   QUICKBOOKS_REDIRECT_URI=http://localhost:3000/api/quickbooks/callback
   ```

2. Connect to real QuickBooks companies (this will require going through QuickBooks app approval process first)

3. For deployed environments, use the production URL in [.env.vercel](file:///c%3A/Users/Carson.D/Documents/GitHub/Accounting-Analytics/web/.env.vercel):
   ```env
   QUICKBOOKS_REDIRECT_URI=https://amy.medrockpharmacy.com/api/quickbooks/callback
   QUICKBOOKS_ENVIRONMENT=production
   ```
