'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import apiClient from '@/lib/api-client';
import { applySession } from '@/lib/session';
import { AlertBanner } from '@/components/ui/feedback';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/,
      'Password must contain uppercase, lowercase, and number/special character'
    ),
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().min(2, 'Last name must be at least 2 characters'),
  tenantName: z.string().min(2, 'Organization name must be at least 2 characters'),
  tenantSlug: z
    .string()
    .min(2, 'Slug must be at least 2 characters')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
});

type RegisterForm = z.infer<typeof registerSchema>;

const parseRegisterError = (error: unknown) => {
  const err = error as { response?: { data?: { message?: string } }; message?: string };
  return err?.response?.data?.message || err?.message || 'Registration failed. Please try again.';
};

export default function RegisterPage() {
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
  });

  const handleTenantNameChange = (name: string) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    setValue('tenantSlug', slug);
  };

  const onSubmit = async (data: RegisterForm) => {
    setError('');
    setIsLoading(true);

    try {
      const response = await apiClient.post('/auth/register', data);

      applySession(response.data);

      // Redirect to dashboard
      window.location.href = '/dashboard';
    } catch (error: unknown) {
      setError(parseRegisterError(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-4 bg-white p-8 rounded-xl shadow-lg">
        <div>
          <h2 className="text-center text-3xl font-bold text-foreground">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-foreground">
            Start your 14-day free trial
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          {error && (
            <AlertBanner tone="error" message={error} />
          )}

          <div className="space-y-4">
            {/* Personal Info */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="firstName" className="form-label">
                  First Name
                </label>
                <input
                  {...register('firstName')}
                  type="text"
                  className="input"
                />
                {errors.firstName && (
                  <p className="mt-1 text-sm text-red-600">{errors.firstName.message}</p>
                )}
              </div>

              <div>
                <label htmlFor="lastName" className="form-label">
                  Last Name
                </label>
                <input
                  {...register('lastName')}
                  type="text"
                  className="input"
                />
                {errors.lastName && (
                  <p className="mt-1 text-sm text-red-600">{errors.lastName.message}</p>
                )}
              </div>
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="form-label">
                Email address
              </label>
              <input
                {...register('email')}
                type="email"
                autoComplete="email"
                className="input"
              />
              {errors.email && (
                <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
              )}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="form-label">
                Password
              </label>
              <input
                {...register('password')}
                type="password"
                autoComplete="new-password"
                className="input"
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>

            {/* Organization Info */}
            <div className="pt-4 border-t border-gray-200">
              <h3 className="text-md font-medium text-foreground mb-3">Organization Details</h3>

              <div>
                <label htmlFor="tenantName" className="form-label">
                  Organization Name
                </label>
                <input
                  {...register('tenantName', {
                    onChange: (e) => handleTenantNameChange(e.target.value),
                  })}
                  type="text"
                  className="input"
                  placeholder="Acme Inc."
                />
                {errors.tenantName && (
                  <p className="mt-1 text-sm text-red-600">{errors.tenantName.message}</p>
                )}
              </div>

              <div className="mt-4">
                <label htmlFor="tenantSlug" className="form-label">
                  Organization Slug
                </label>
                <input
                  {...register('tenantSlug')}
                  type="text"
                  className="input font-mono text-sm"
                  placeholder="acme-inc"
                />
                <p className="mt-1 text-xs text-gray-500">
                  This will be used in your organization's URL
                </p>
                {errors.tenantSlug && (
                  <p className="mt-1 text-sm text-red-600">{errors.tenantSlug.message}</p>
                )}
              </div>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full btn btn-lg btn-primary"
            >
              {isLoading ? 'Creating account...' : 'Create account'}
            </button>
          </div>

          <div className="text-center text-sm">
            <span className="text-foreground">Already have an account? </span>
            <Link href="/login" className="font-medium text-foreground hover:text-gray-700">
              Sign in
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
