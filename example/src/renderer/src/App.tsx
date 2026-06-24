import { useState } from 'react';
import { Theme, Container, Flex, Box, Card, Button } from '@radix-ui/themes';
import { Home } from './components/Home';
import { Account } from './components/Account';
import { SignInButton } from './components/SignInButton';
import { Footer } from './components/Footer';

export type View = 'home' | 'account';

function App(): React.JSX.Element {
  const [currentView, setCurrentView] = useState<View>('home');

  return (
    <Theme accentColor="iris" panelBackground="solid" style={{ backgroundColor: 'var(--gray-1)' }}>
      <Container style={{ backgroundColor: 'var(--gray-1)' }}>
        <Flex direction="column" gap="5" p="5" style={{ minHeight: '100vh' }}>
          <Box asChild flexGrow="1">
            <Card size="4">
              <Flex direction="column" height="100%">
                <Flex asChild justify="between">
                  <header>
                    <Flex gap="4">
                      <Button variant="soft" onClick={() => setCurrentView('home')}>
                        Home
                      </Button>
                      <Button variant="soft" onClick={() => setCurrentView('account')}>
                        Account
                      </Button>
                    </Flex>
                    <SignInButton />
                  </header>
                </Flex>

                <Flex flexGrow="1" align="center" justify="center">
                  <main>
                    {currentView === 'home' && <Home onNavigate={setCurrentView} />}
                    {currentView === 'account' && <Account onNavigate={setCurrentView} />}
                  </main>
                </Flex>
              </Flex>
            </Card>
          </Box>
          <Footer />
        </Flex>
      </Container>
    </Theme>
  );
}

export default App;
