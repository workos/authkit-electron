import { Flex, Heading, Text, Button } from '@radix-ui/themes';
import { useAuth } from '@workos/authkit-electron/react';
import { SignInButton } from './SignInButton';
import type { View } from '../App';

interface HomeProps {
  onNavigate: (view: View) => void;
}

export function Home({ onNavigate }: HomeProps): React.JSX.Element {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <Text>Loading...</Text>;
  }

  return (
    <Flex direction="column" align="center" gap="2">
      {user ? (
        <>
          <Heading data-testid="welcome" size="8">
            Welcome back{user.firstName && `, ${user.firstName}`}
          </Heading>
          <Text size="5" color="gray">
            You are now authenticated into the application
          </Text>
          <Flex align="center" gap="3" mt="4">
            <Button size="3" variant="soft" onClick={() => onNavigate('account')}>
              View account
            </Button>
            <SignInButton large />
          </Flex>
        </>
      ) : (
        <>
          <Heading size="8">Electron AuthKit Example</Heading>
          <Text size="5" color="gray" mb="4">
            Sign in to view your account details
          </Text>
          <SignInButton large />
        </>
      )}
    </Flex>
  );
}
