import { useEffect } from 'react';
import { Flex, Heading, Text, TextField, Box } from '@radix-ui/themes';
import { useAuth } from '@workos/authkit-electron/react';
import type { View } from '../App';

interface AccountProps {
  onNavigate: (view: View) => void;
}

export function Account({ onNavigate }: AccountProps): React.JSX.Element | null {
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      onNavigate('home');
    }
  }, [user, isLoading, onNavigate]);

  if (isLoading) {
    return <Text>Loading...</Text>;
  }

  if (!user) {
    return null;
  }

  const userFields = [
    ['First name', user.firstName],
    ['Last name', user.lastName],
    ['Email', user.email],
    ['Id', user.id],
  ].filter(([, value]) => value != null);

  return (
    <>
      <Flex direction="column" gap="2" mb="7">
        <Heading size="8" align="center">
          Account details
        </Heading>
        <Text size="5" align="center" color="gray">
          Below are your account details
        </Text>
      </Flex>

      <Flex direction="column" justify="center" gap="3" style={{ width: 400 }}>
        {userFields.map(([label, value]) => (
          <Flex asChild align="center" gap="6" key={label}>
            <label>
              <Text weight="bold" size="3" style={{ width: 100 }}>
                {label}
              </Text>
              <Box flexGrow="1">
                <TextField.Root value={value ?? ''} readOnly />
              </Box>
            </label>
          </Flex>
        ))}
      </Flex>
    </>
  );
}
