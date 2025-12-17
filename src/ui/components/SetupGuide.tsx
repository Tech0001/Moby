import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/ui/components/ui/card";
import { Button } from "@/ui/components/ui/button";
import { CheckCircle2, Circle, ArrowRight, Key, RefreshCw, Settings, Play } from 'lucide-react';

interface SetupGuideProps {
  hasApiKeys: boolean;
  hasConfiguredAssets: boolean;
  isSweeperEnabled: boolean;
  onNavigate: (tab: string) => void;
  onToggleSweeper: () => void;
}

export function SetupGuide({ 
  hasApiKeys, 
  hasConfiguredAssets, 
  isSweeperEnabled,
  onNavigate,
  onToggleSweeper 
}: SetupGuideProps) {
  
  // Determine current active step
  let currentStep = 1;
  if (hasApiKeys) currentStep = 2;
  if (hasApiKeys && hasConfiguredAssets) currentStep = 3;
  if (hasApiKeys && hasConfiguredAssets && isSweeperEnabled) currentStep = 4;

  if (currentStep === 4) return null; // Setup complete

  const steps = [
    {
      id: 1,
      title: "Connect Exchange",
      description: "Add your exchange API keys to allow Moby to read balances and execute withdrawals.",
      icon: Key,
      action: "Go to API Keys",
      targetTab: "api-keys",
      isComplete: hasApiKeys,
    },
    {
      id: 2,
      title: "Sync & Configure",
      description: "Sync your withdrawal addresses and select which assets you want to sweep.",
      icon: Settings,
      action: "Go to Configuration",
      targetTab: "config",
      isComplete: hasConfiguredAssets,
    },
    {
      id: 3,
      title: "Start Sweeper",
      description: "Enable the background sweeper to start monitoring for deposits.",
      icon: Play,
      action: "Start Sweeper",
      isAction: true,
      isComplete: isSweeperEnabled,
    }
  ];

  return (
    <Card className="mb-8 border-primary/20 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-primary" />
          Setup Guide
        </CardTitle>
        <CardDescription>
          Complete these steps to get Moby up and running.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {steps.map((step) => {
            const isActive = step.id === currentStep;
            const isPast = step.id < currentStep;
            const isFuture = step.id > currentStep;

            return (
              <div 
                key={step.id}
                className={`flex items-start gap-4 p-4 rounded-lg border transition-all ${
                  isActive 
                    ? 'bg-background border-primary/50 shadow-sm' 
                    : 'border-transparent opacity-70'
                }`}
              >
                <div className="mt-1">
                  {isPast ? (
                    <CheckCircle2 className="w-6 h-6 text-green-500" />
                  ) : isActive ? (
                    <div className="w-6 h-6 rounded-full border-2 border-primary flex items-center justify-center">
                      <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
                    </div>
                  ) : (
                    <Circle className="w-6 h-6 text-muted-foreground" />
                  )}
                </div>
                
                <div className="flex-1 space-y-1">
                  <h4 className={`font-medium ${isActive ? 'text-primary' : ''}`}>
                    {step.title}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {step.description}
                  </p>
                  
                  {isActive && (
                    <div className="pt-2">
                      {step.isAction ? (
                        <Button onClick={onToggleSweeper} size="sm" className="gap-2">
                          <Play size={14} />
                          {step.action}
                        </Button>
                      ) : (
                        <Button onClick={() => onNavigate(step.targetTab!)} size="sm" className="gap-2">
                          {step.action}
                          <ArrowRight size={14} />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
