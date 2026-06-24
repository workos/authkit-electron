import { Button, Text } from '@radix-ui/themes';
import { useAuth } from '@workos/authkit-electron/react';

interface SignInButtonProps {
  large?: boolean;
}

export function SignInButton({ large }: SignInButtonProps): React.JSX.Element {
  const { user, isLoading, signIn, signOut } = useAuth();

  if (isLoading) {
    return <Text data-testid="auth-loading">Loading...</Text>;
  }

  if (user) {
    return (
      <Button data-testid="sign-out" size={large ? '3' : '2'} onClick={() => void signOut()}>
        Sign Out
      </Button>
    );
  }

  return (
    <Button data-testid="sign-in" size={large ? '3' : '2'} onClick={() => void signIn()}>
      Sign In{large && ' with AuthKit'}
    </Button>
  );
}
