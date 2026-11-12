import { useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { WmsFulfillmentItemChange } from '@/src/features/picking/types';
import { tokens } from '@/src/shared/theme/tokens';
import { OrderDetachmentPanel } from './order-detachment-panel';

export function OrderChangeNotice({
  change,
  disabled = false,
  canDetach = false,
  onStartDetachment,
  onReturnDetachedUnit,
  onReturnUnit,
}: {
  change: WmsFulfillmentItemChange | null;
  disabled?: boolean;
  canDetach?: boolean;
  onStartDetachment?: (confirmation: string, reason: string) => Promise<boolean>;
  onReturnDetachedUnit?: (binCode: string, unitCode: string) => Promise<boolean>;
  onReturnUnit?: (code: string) => Promise<boolean>;
}) {
  const [returnCode, setReturnCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  if (!change) return null;

  const needsReturn = !change.detachment && change.requiresAction && change.returnUnitsRemaining > 0 && onReturnUnit;
  const submitReturn = async () => {
    const code = returnCode.trim();
    if (!code || submitting || disabled || !onReturnUnit) return;
    setSubmitting(true);
    try {
      if (await onReturnUnit(code)) setReturnCode('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.container, change.requiresAction ? styles.actionContainer : styles.infoContainer]}>
      <View style={styles.titleRow}>
        <View style={styles.iconCircle}>
          <Feather
            name={change.requiresAction ? 'alert-triangle' : 'refresh-cw'}
            size={17}
            color={change.requiresAction ? tokens.colors.danger : tokens.colors.panel}
          />
        </View>
        <View style={styles.titleCopy}>
          <Text style={styles.eyebrow}>
            {change.requiresAction ? 'ORDER CHANGE NOTE · REWORK REQUIRED' : 'ORDER CHANGE NOTE · AUTOMATIC REVISION'}
          </Text>
          <Text style={styles.title}>{change.title}</Text>
          <Text style={styles.message}>{change.message}</Text>
        </View>
      </View>

      <View style={styles.metricsRow}>
        {change.addedUnits > 0 ? (
          <View style={styles.metricPill}><Text style={styles.metricText}>+{change.addedUnits} to pick</Text></View>
        ) : null}
        {change.removedUnits > 0 ? (
          <View style={styles.metricPill}><Text style={styles.metricText}>−{change.removedUnits} removed</Text></View>
        ) : null}
        {change.returnUnitsRemaining > 0 ? (
          <View style={styles.returnPill}><Text style={styles.returnText}>{change.returnUnitsRemaining} to return</Text></View>
        ) : null}
      </View>

      {change.order ? (
        <View style={styles.orderRow}>
          <View style={styles.orderIcon}>
            <Feather name="file-text" size={14} color={tokens.colors.panel} />
          </View>
          <View style={styles.orderCopy}>
            <Text style={styles.orderLabel}>Affected order</Text>
            <Text style={styles.orderValue}>#{change.order.posOrderId}</Text>
          </View>
          <Text numberOfLines={1} style={styles.orderMeta}>
            {change.order.tracking ? `Waybill ${change.order.tracking}` : 'No waybill yet'}
          </Text>
        </View>
      ) : null}

      <OrderDetachmentPanel
        canDetach={canDetach}
        change={change}
        disabled={disabled}
        onReturnUnit={onReturnDetachedUnit}
        onStart={onStartDetachment}
      />

      {!change.detachment ? (change.returnSteps ?? []).map((step) => (
        <View key={`return-${step.variationId}`} style={styles.instructionCard}>
          <View style={styles.instructionHeader}>
            <View style={styles.returnIcon}>
              <Feather name="rotate-ccw" size={15} color={tokens.colors.danger} />
            </View>
            <View style={styles.instructionCopy}>
              <Text style={styles.instructionEyebrow}>REMOVE & RETURN · {step.quantity}</Text>
              <Text style={styles.instructionTitle}>{step.productName}</Text>
              <Text style={styles.productCode}>Item {step.productDisplayId ?? step.variationId}</Text>
            </View>
          </View>

          {step.serializedUnits.map((unit) => (
            <View key={unit.id} style={styles.unitRow}>
              <View style={styles.unitCodeGroup}>
                <Text style={styles.unitLabel}>Serialized code</Text>
                <Text selectable style={styles.unitCode}>{unit.code ?? unit.barcode ?? 'Scan label'}</Text>
              </View>
              <View style={styles.binGroup}>
                <Text style={styles.unitLabel}>Return to</Text>
                <Text style={styles.binCode}>{unit.sourceBin?.code ?? 'Original bin unavailable'}</Text>
              </View>
            </View>
          ))}

          {step.unidentifiedQuantity > 0 ? (
            <View style={styles.warningRow}>
              <Feather name="alert-circle" size={14} color={tokens.colors.danger} />
              <Text style={styles.warningText}>
                {step.unidentifiedQuantity} serialized unit {step.unidentifiedQuantity === 1 ? 'is' : 'are'} not linked to this order. Match the item code above and scan its label from this basket.
              </Text>
            </View>
          ) : null}
        </View>
      )) : null}

      {!change.detachment ? (change.pickSteps ?? []).map((step) => (
        <View key={`pick-${step.variationId}`} style={styles.instructionCard}>
          <View style={styles.instructionHeader}>
            <View style={styles.pickIcon}>
              <Feather name="plus" size={16} color={tokens.colors.panel} />
            </View>
            <View style={styles.instructionCopy}>
              <Text style={styles.instructionEyebrow}>ADD & PICK · {step.quantity}</Text>
              <Text style={styles.instructionTitle}>{step.productName}</Text>
              <Text style={styles.productCode}>Item {step.productDisplayId ?? step.variationId}</Text>
            </View>
          </View>

          {step.serializedUnits.map((unit) => (
            <View key={unit.id} style={styles.unitRow}>
              <View style={styles.unitCodeGroup}>
                <Text style={styles.unitLabel}>Pick serialized code</Text>
                <Text selectable style={styles.unitCode}>{unit.code ?? unit.barcode ?? 'Scan label'}</Text>
              </View>
              <View style={styles.binGroup}>
                <Text style={styles.unitLabel}>From bin</Text>
                <Text style={styles.binCode}>{unit.sourceBin?.code ?? 'Bin unavailable'}</Text>
              </View>
            </View>
          ))}

          {step.sourceBins.map((source) => (
            <View key={source.location.id} style={styles.unitRow}>
              <View style={styles.unitCodeGroup}>
                <Text style={styles.unitLabel}>Pick from bin</Text>
                <Text style={styles.unitCode}>{source.location.code}</Text>
              </View>
              <View style={styles.binGroup}>
                <Text style={styles.unitLabel}>Quantity</Text>
                <Text style={styles.binCode}>{source.quantity}</Text>
              </View>
            </View>
          ))}

          {step.scanAnyMatchingUnit ? (
            <Text style={styles.scanHint}>At the bin, scan any serialized unit matching item {step.productDisplayId ?? step.variationId}.</Text>
          ) : null}

          {step.unallocatedQuantity > 0 ? (
            <View style={styles.warningRow}>
              <Feather name="clock" size={14} color={tokens.colors.danger} />
              <Text style={styles.warningText}>
                No pickable bin is allocated for {step.unallocatedQuantity} unit{step.unallocatedQuantity === 1 ? '' : 's'}. Wait for putaway or retry allocation; do not substitute another item.
              </Text>
            </View>
          ) : null}
        </View>
      )) : null}

      {needsReturn ? (
        <View style={styles.returnSection}>
          <Text style={styles.stepTitle}>First, scan the excess or replaced item</Text>
          <Text style={styles.stepCopy}>The item will be removed from this basket and returned to its original bin.</Text>
          <View style={styles.inputRow}>
            <TextInput
              autoCapitalize="characters"
              editable={!disabled && !submitting}
              onChangeText={setReturnCode}
              onSubmitEditing={() => void submitReturn()}
              placeholder="Scan item code"
              placeholderTextColor={tokens.colors.inkSoft}
              style={styles.input}
              value={returnCode}
            />
            <Pressable
              disabled={!returnCode.trim() || disabled || submitting}
              onPress={() => void submitReturn()}
              style={({ pressed }) => [styles.returnButton, pressed && styles.returnButtonPressed]}
            >
              {submitting ? (
                <ActivityIndicator color={tokens.colors.surface} size="small" />
              ) : (
                <Feather name="corner-down-left" size={18} color={tokens.colors.surface} />
              )}
            </Pressable>
          </View>
        </View>
      ) : change.detachment ? null : change.requiresAction ? (
        <Text style={styles.nextStep}>Continue with the refreshed pick list below. Packing stays blocked until it is complete.</Text>
      ) : (
        <Text style={styles.nextStep}>No manual sync is needed. Continue using the refreshed quantities below.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
    padding: tokens.spacing.md,
  },
  actionContainer: { backgroundColor: '#FFF4EF', borderColor: '#F2B8A9' },
  infoContainer: { backgroundColor: tokens.colors.accentSoft, borderColor: tokens.colors.accentStrong },
  titleRow: { alignItems: 'flex-start', flexDirection: 'row', gap: tokens.spacing.sm },
  iconCircle: {
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderRadius: tokens.radius.pill,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  titleCopy: { flex: 1, gap: 3 },
  eyebrow: { color: tokens.colors.panel, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: tokens.colors.ink, fontSize: 15, fontWeight: '800' },
  message: { color: tokens.colors.inkMuted, fontSize: 13, lineHeight: 19 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.xs },
  metricPill: { backgroundColor: tokens.colors.surface, borderRadius: tokens.radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  metricText: { color: tokens.colors.panel, fontSize: 12, fontWeight: '700' },
  returnPill: { backgroundColor: '#FBE0DA', borderRadius: tokens.radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  returnText: { color: tokens.colors.danger, fontSize: 12, fontWeight: '800' },
  orderRow: {
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: tokens.spacing.xs,
    padding: tokens.spacing.sm,
  },
  orderIcon: {
    alignItems: 'center',
    backgroundColor: tokens.colors.accentSoft,
    borderRadius: tokens.radius.pill,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  orderCopy: { flex: 1 },
  orderLabel: { color: tokens.colors.inkMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  orderValue: { color: tokens.colors.ink, fontSize: 14, fontWeight: '900' },
  orderMeta: { color: tokens.colors.inkMuted, flexShrink: 1, fontSize: 11, fontWeight: '700', maxWidth: '45%' },
  instructionCard: {
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    gap: tokens.spacing.xs,
    padding: tokens.spacing.sm,
  },
  instructionHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: tokens.spacing.xs },
  instructionCopy: { flex: 1 },
  instructionEyebrow: { color: tokens.colors.inkMuted, fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  instructionTitle: { color: tokens.colors.ink, fontSize: 13, fontWeight: '900', marginTop: 2 },
  productCode: { color: tokens.colors.inkMuted, fontSize: 11, fontWeight: '700', marginTop: 2 },
  returnIcon: {
    alignItems: 'center',
    backgroundColor: '#FBE0DA',
    borderRadius: tokens.radius.pill,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  pickIcon: {
    alignItems: 'center',
    backgroundColor: tokens.colors.accentSoft,
    borderRadius: tokens.radius.pill,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  unitRow: {
    alignItems: 'center',
    backgroundColor: '#F7F9FA',
    borderRadius: tokens.radius.sm,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  unitCodeGroup: { flex: 1 },
  binGroup: { alignItems: 'flex-end', flexShrink: 0 },
  unitLabel: { color: tokens.colors.inkMuted, fontSize: 9, fontWeight: '700', textTransform: 'uppercase' },
  unitCode: { color: tokens.colors.ink, fontSize: 12, fontWeight: '900', marginTop: 2 },
  binCode: { color: tokens.colors.panel, fontSize: 12, fontWeight: '900', marginTop: 2 },
  scanHint: { color: tokens.colors.inkMuted, fontSize: 11, lineHeight: 16 },
  warningRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 6, paddingTop: 2 },
  warningText: { color: tokens.colors.danger, flex: 1, fontSize: 11, fontWeight: '700', lineHeight: 16 },
  returnSection: { borderTopColor: '#F0D3CA', borderTopWidth: 1, gap: 4, paddingTop: tokens.spacing.sm },
  stepTitle: { color: tokens.colors.ink, fontSize: 13, fontWeight: '800' },
  stepCopy: { color: tokens.colors.inkMuted, fontSize: 12, lineHeight: 18 },
  inputRow: { flexDirection: 'row', gap: tokens.spacing.xs, marginTop: tokens.spacing.xs },
  input: {
    backgroundColor: tokens.colors.surface,
    borderColor: tokens.colors.border,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    color: tokens.colors.ink,
    flex: 1,
    fontSize: 14,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  returnButton: {
    alignItems: 'center',
    backgroundColor: tokens.colors.panel,
    borderRadius: tokens.radius.sm,
    justifyContent: 'center',
    width: 48,
  },
  returnButtonPressed: { opacity: 0.8 },
  nextStep: { color: tokens.colors.inkMuted, fontSize: 12, lineHeight: 18 },
});
