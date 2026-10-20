'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import apiClient from '@/lib/api-client';
import { applySession } from '@/lib/session';
import { AlertBanner } from '@/components/ui/feedback';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

const parseLoginError = (error: unknown) => {
  const err = error as { response?: { data?: { message?: string } }; message?: string };
  return (
    err?.response?.data?.message ||
    err?.message ||
    'Login failed. Please check your credentials.'
  );
};

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // Redirect away from login if already authenticated
  useEffect(() => {
    const notice = window.sessionStorage.getItem('auth_session_notice');
    if (notice) {
      setSessionNotice(notice);
      window.sessionStorage.removeItem('auth_session_notice');
    }
    const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
    if (token) {
      router.push('/dashboard');
    } else {
      setCheckingSession(false);
    }
  }, [router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginForm) => {
    setError('');
    setIsLoading(true);

    try {
      const response = await apiClient.post('/auth/login', {
        email: data.email.trim().toLowerCase(),
        password: data.password,
      });

      // A fresh login is never an impersonation, whatever a previous session
      // left behind — including one under a different partner.
      localStorage.removeItem('impersonating_user');

      applySession(response.data);
      const memberships = Array.isArray(response.data.memberships) ? response.data.memberships : [];

      // One tenant: straight in, exactly as before. Several: let them choose.
      window.location.href = memberships.length > 1 ? '/select-workspace' : '/dashboard';
    } catch (error: unknown) {
      setError(parseLoginError(error));
    } finally {
      setIsLoading(false);
    }
  };

  if (checkingSession) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-4 bg-surface p-8 rounded-xl shadow-lg">
        <div>
          <h2 className="text-center text-3xl font-bold text-foreground">
            Sign in to your account
          </h2>
          <p className="mt-2 text-center text-sm text-foreground">
            Welcome back! Please enter your details.
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          {sessionNotice && <AlertBanner tone="warning" message={sessionNotice} />}
          {error && (
            <AlertBanner tone="error" message={error} />
          )}

          <div className="space-y-4">
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

            <div>
              <label htmlFor="password" className="form-label">
                Password
              </label>
              <input
                {...register('password')}
                type="password"
                autoComplete="current-password"
                className="input"
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <input
                id="remember-me"
                name="remember-me"
                type="checkbox"
                className="h-4 w-4 text-foreground focus:ring-gray-900 border-gray-300 rounded"
              />
              <label htmlFor="remember-me" className="ml-2 block text-sm text-foreground">
                Remember me
              </label>
            </div>

            <div className="text-sm">
              <a href="#" className="font-medium text-foreground">
                Forgot password?
              </a>
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={isLoading}
              className="btn btn-lg btn-primary w-full"
            >
              {isLoading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
