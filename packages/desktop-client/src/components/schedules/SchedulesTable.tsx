// @ts-strict-ignore
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgExpandArrow } from '@actual-app/components/icons/v0';
import { SvgDotsHorizontalTriple } from '@actual-app/components/icons/v1';
import { SvgCheck } from '@actual-app/components/icons/v2';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { format as monthUtilFormat } from '@actual-app/core/shared/months';
import { getNormalisedString } from '@actual-app/core/shared/normalisation';
import { getScheduledAmount } from '@actual-app/core/shared/schedules';
import type {
  ScheduleStatuses,
  ScheduleStatusType,
} from '@actual-app/core/shared/schedules';
import type {
  CategoryEntity,
  RecurConfig,
  ScheduleEntity,
} from '@actual-app/core/types/models';
import type { TFunction } from 'i18next';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { Cell, Field, Row, Table, TableHeader } from '#components/table';
import { DisplayId } from '#components/util/DisplayId';
import { useAccounts } from '#hooks/useAccounts';
import { useCategories } from '#hooks/useCategories';
import { useContextMenu } from '#hooks/useContextMenu';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { usePayees } from '#hooks/usePayees';

import { StatusBadge } from './StatusBadge';

export type GroupBy = 'nothing' | 'frequency' | 'category' | 'account';

type GroupHeaderItem = {
  id: string;
  type: 'group-header';
  label: string;
  totalAmount: number;
};

type SplitScheduleItem = {
  id: string;
  type: 'split';
  schedule: ScheduleEntity;
  categoryId: string | null;
  amount: number;
};

type CompletedScheduleItem = { id: 'show-completed' };
type SchedulesTableItem =
  | ScheduleEntity
  | CompletedScheduleItem
  | GroupHeaderItem
  | SplitScheduleItem;

type SchedulesTableProps = {
  isLoading?: boolean;
  schedules: readonly ScheduleEntity[];
  statuses: ScheduleStatuses;
  filter: string;
  allowCompleted: boolean;
  groupBy?: GroupBy;
  onSelect: (id: ScheduleEntity['id']) => void;
  style: CSSProperties;
  tableStyle?: CSSProperties;
} & (
  | {
      minimal: true;
      onAction?: never;
    }
  | {
      minimal?: false;
      onAction: (
        actionName: ScheduleItemAction,
        id: ScheduleEntity['id'],
      ) => void;
    }
);

export type ScheduleItemAction =
  | 'post-transaction'
  | 'post-transaction-today'
  | 'skip'
  | 'complete'
  | 'restart'
  | 'delete';

export const ROW_HEIGHT = 43;

function getFrequencyGroupInfo(
  schedule: ScheduleEntity,
  t: TFunction,
): { label: string; order: number } {
  const date = schedule._date;
  if (!date || typeof date === 'string') {
    return { label: t('One-time'), order: 100 };
  }
  const { frequency, interval = 1 } = date as RecurConfig;
  switch (frequency) {
    case 'daily':
      return interval === 1
        ? { label: t('Daily'), order: 0 }
        : { label: t('Every {{n}} days', { n: interval }), order: 0 };
    case 'weekly':
      return interval === 1
        ? { label: t('Weekly'), order: 1 }
        : { label: t('Every {{n}} weeks', { n: interval }), order: 1 };
    case 'monthly':
      if (interval === 1) return { label: t('Monthly'), order: 3 };
      if (interval === 3) return { label: t('Quarterly'), order: 4 };
      return {
        label: t('Every {{n}} months', { n: interval }),
        order: 5,
      };
    case 'yearly':
      return interval === 1
        ? { label: t('Yearly'), order: 6 }
        : { label: t('Every {{n}} years', { n: interval }), order: 7 };
    default:
      return { label: t('Other'), order: 99 };
  }
}

type ScheduleCategoryInfo = {
  categoryId: string | null;
  amount: number;
  splitIndex: number | null;
};

function getScheduleCategories(
  schedule: ScheduleEntity,
): ScheduleCategoryInfo[] {
  const actions = schedule._actions as Array<{
    op: string;
    field?: string;
    value?: unknown;
    options?: {
      splitIndex?: number;
      method?: 'fixed-amount' | 'fixed-percent' | 'formula' | 'remainder';
    };
  }>;

  const categoryActions = actions.filter(
    a => a.op === 'set' && a.field === 'category',
  );

  if (categoryActions.length === 0) {
    return [
      {
        categoryId: null,
        amount: getScheduledAmount(schedule._amount),
        splitIndex: null,
      },
    ];
  }

  const splitCategoryActions = categoryActions.filter(
    a => a.options?.splitIndex !== undefined && a.options.splitIndex > 0,
  );

  if (splitCategoryActions.length === 0) {
    return [
      {
        categoryId: categoryActions[0].value as string,
        amount: getScheduledAmount(schedule._amount),
        splitIndex: null,
      },
    ];
  }

  const totalAmount = getScheduledAmount(schedule._amount);
  const splitAmountActions = actions.filter(a => a.op === 'set-split-amount');

  const splitAmounts = new Map<number, number>();
  let remainderIndex: number | null = null;
  let fixedSum = 0;

  for (const sa of splitAmountActions) {
    const idx = sa.options?.splitIndex ?? 0;
    if (idx === 0) continue;
    if (sa.options?.method === 'fixed-amount' && typeof sa.value === 'number') {
      splitAmounts.set(idx, sa.value);
      fixedSum += sa.value;
    } else if (
      sa.options?.method === 'fixed-percent' &&
      typeof sa.value === 'number'
    ) {
      const val = Math.round(totalAmount * (sa.value / 100));
      splitAmounts.set(idx, val);
      fixedSum += val;
    } else if (sa.options?.method === 'remainder') {
      remainderIndex = idx;
    }
  }

  if (remainderIndex !== null) {
    splitAmounts.set(remainderIndex, totalAmount - fixedSum);
  }

  return splitCategoryActions.map(catAction => {
    const idx = catAction.options?.splitIndex ?? 0;
    return {
      categoryId: catAction.value as string,
      amount: splitAmounts.get(idx) ?? 0,
      splitIndex: idx,
    };
  });
}

function GroupHeaderRow({
  label,
  totalAmount,
  groupId,
  collapsed,
  onToggle,
  minimal,
}: {
  label: string;
  totalAmount: number;
  groupId: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  minimal?: boolean;
}) {
  const format = useFormat();

  const num = totalAmount;
  const absAmount = format(Math.abs(num || 0), 'financial');
  const isPositive = num > 0;

  return (
    <Row
      height={ROW_HEIGHT}
      inset={15}
      onClick={() => onToggle(groupId)}
      style={{
        cursor: 'pointer',
        backgroundColor: theme.budgetHeaderCurrentMonth,
        color: 'white',
        ':hover': {
          backgroundColor: theme.budgetHeaderCurrentMonth,
          filter: 'brightness(0.9)',
        },
      }}
    >
      <Field width="flex" name="name">
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <SvgExpandArrow
            width={8}
            height={8}
            style={{
              marginRight: 8,
              marginLeft: 5,
              flexShrink: 0,
              transition: 'transform .1s',
              transform: collapsed ? 'rotate(-90deg)' : '',
              color: 'white',
            }}
          />
          <Text style={{ fontWeight: 600, color: 'white' }}>{label}</Text>
        </View>
      </Field>
      <Field width="flex" name="payee" />
      <Field width="flex" name="account" />
      <Field width={110} name="date" />
      <Field width={120} name="status" />
      <Cell
        width={100}
        plain
        style={{
          textAlign: 'right',
          flexDirection: 'row',
          alignItems: 'center',
          padding: '0 5px',
        }}
        name="amount"
      >
        <FinancialText
          style={{
            flex: 1,
            color: 'white',
            whiteSpace: 'nowrap',
          }}
        >
          <PrivacyFilter>
            {isPositive ? `+${absAmount}` : `${absAmount}`}
          </PrivacyFilter>
        </FinancialText>
      </Cell>
      {!minimal && <Field width={80} />}
      {!minimal && <Field width={40} />}
    </Row>
  );
}

function OverflowMenu({
  schedule,
  status,
  onAction,
}: {
  schedule: ScheduleEntity;
  status: ScheduleStatusType;
  onAction: SchedulesTableProps['onAction'];
}) {
  const { t } = useTranslation();

  const getMenuItems = () => {
    const menuItems: { name: ScheduleItemAction; text: string }[] = [];

    menuItems.push(
      {
        name: 'post-transaction',
        text: t('Post transaction'),
      },
      {
        name: 'post-transaction-today',
        text: t('Post transaction today'),
      },
    );

    if (status === 'completed') {
      menuItems.push({
        name: 'restart',
        text: t('Restart'),
      });
    } else {
      menuItems.push(
        {
          name: 'skip',
          text: t('Skip next scheduled date'),
        },
        {
          name: 'complete',
          text: t('Complete'),
        },
      );
    }

    menuItems.push({ name: 'delete', text: t('Delete') });

    return menuItems;
  };

  return (
    <Menu
      onMenuSelect={name => {
        onAction(name, schedule.id);
      }}
      items={getMenuItems()}
    />
  );
}

export function ScheduleAmountCell({
  amount,
  op,
}: {
  amount: ScheduleEntity['_amount'];
  op: ScheduleEntity['_amountOp'];
}) {
  const { t } = useTranslation();
  const format = useFormat();

  const num = getScheduledAmount(amount);
  const currencyAmount = format(Math.abs(num || 0), 'financial');
  const isApprox = op === 'isapprox' || op === 'isbetween';

  return (
    <Cell
      width={100}
      plain
      style={{
        textAlign: 'right',
        flexDirection: 'row',
        alignItems: 'center',
        padding: '0 5px',
      }}
      name="amount"
    >
      {isApprox && (
        <View
          style={{
            textAlign: 'left',
            color: theme.pageTextSubdued,
            lineHeight: '1em',
            marginRight: 10,
          }}
          title={
            isApprox
              ? t('Approximately {{currencyAmount}}', { currencyAmount })
              : currencyAmount
          }
        >
          ~
        </View>
      )}
      <FinancialText
        style={{
          flex: 1,
          color: num > 0 ? theme.noticeTextLight : theme.tableText,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={
          isApprox
            ? t('Approximately {{currencyAmount}}', { currencyAmount })
            : currencyAmount
        }
      >
        <PrivacyFilter>
          {num > 0 ? `+${currencyAmount}` : `${currencyAmount}`}
        </PrivacyFilter>
      </FinancialText>
    </Cell>
  );
}

function ScheduleRow({
  schedule,
  onAction,
  onSelect,
  minimal,
  statuses,
  dateFormat,
  overrideAmount,
}: {
  schedule: ScheduleEntity;
  dateFormat: string;
  overrideAmount?: number;
} & Pick<
  SchedulesTableProps,
  'onSelect' | 'onAction' | 'minimal' | 'statuses'
>) {
  const { t } = useTranslation();

  const rowRef = useRef(null);
  const buttonRef = useRef(null);
  const {
    setMenuOpen,
    menuOpen,
    handleContextMenu,
    resetPosition,
    position,
    asContextMenu,
  } = useContextMenu();

  return (
    <Row
      ref={rowRef}
      height={ROW_HEIGHT}
      inset={15}
      onClick={() => onSelect(schedule.id)}
      style={{
        cursor: 'pointer',
        backgroundColor: theme.tableBackground,
        color: theme.tableText,
        ':hover': { backgroundColor: theme.tableRowBackgroundHover },
      }}
      onContextMenu={handleContextMenu}
    >
      {!minimal && (
        <Popover
          triggerRef={asContextMenu ? rowRef : buttonRef}
          isOpen={menuOpen}
          onOpenChange={() => setMenuOpen(false)}
          isNonModal
          placement="bottom start"
          {...position}
          style={{ margin: 1 }}
        >
          <OverflowMenu
            schedule={schedule}
            status={statuses.get(schedule.id)}
            onAction={(action, id) => {
              onAction(action, id);
              resetPosition();
              setMenuOpen(false);
            }}
          />
        </Popover>
      )}
      <Field width="flex" name="name">
        <Text
          style={
            schedule.name == null
              ? { color: theme.buttonNormalDisabledText }
              : null
          }
          title={schedule.name ? schedule.name : ''}
        >
          {schedule.name ? schedule.name : t('None')}
        </Text>
      </Field>
      <Field width="flex" name="payee">
        <DisplayId type="payees" id={schedule._payee} />
      </Field>
      <Field width="flex" name="account">
        <DisplayId type="accounts" id={schedule._account} />
      </Field>
      <Field width={110} name="date">
        {schedule.next_date
          ? monthUtilFormat(schedule.next_date, dateFormat)
          : null}
      </Field>
      <Field width={120} name="status" style={{ alignItems: 'flex-start' }}>
        <StatusBadge status={statuses.get(schedule.id)} />
      </Field>
      <ScheduleAmountCell
        amount={
          overrideAmount !== undefined ? overrideAmount : schedule._amount
        }
        op={overrideAmount !== undefined ? 'is' : schedule._amountOp}
      />
      {!minimal && (
        <Field width={80} style={{ textAlign: 'center' }}>
          {schedule._date &&
            typeof schedule._date === 'object' &&
            schedule._date.frequency && (
              <SvgCheck style={{ width: 13, height: 13 }} />
            )}
        </Field>
      )}
      {!minimal && (
        <Field width={40} name="actions">
          <View>
            <Button
              ref={buttonRef}
              variant="bare"
              aria-label={t('Menu')}
              onPress={() => {
                resetPosition();
                setMenuOpen(true);
              }}
            >
              <SvgDotsHorizontalTriple
                width={15}
                height={15}
                style={{ transform: 'rotateZ(90deg)' }}
              />
            </Button>
          </View>
        </Field>
      )}
    </Row>
  );
}

export function SchedulesTable({
  isLoading,
  schedules,
  statuses,
  filter,
  minimal,
  allowCompleted,
  groupBy,
  style,
  onSelect,
  onAction,
  tableStyle,
}: SchedulesTableProps) {
  const { t } = useTranslation();
  const format = useFormat();

  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const [showCompleted, setShowCompleted] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    setCollapsedGroups(new Set());
  }, [groupBy]);

  const { data: payees } = usePayees();
  const { data: accounts = [] } = useAccounts();
  const { data: categoriesData } = useCategories();

  const categoriesById = useMemo(() => {
    const map = new Map<string, CategoryEntity>();
    for (const cat of categoriesData?.list ?? []) {
      map.set(cat.id, cat);
    }
    return map;
  }, [categoriesData]);

  const filteredSchedules = useMemo(() => {
    if (!filter) {
      return schedules;
    }
    const filterIncludes = (str: string) =>
      str
        ? getNormalisedString(str).includes(getNormalisedString(filter)) ||
          getNormalisedString(filter).includes(getNormalisedString(str))
        : false;

    return schedules.filter(schedule => {
      const payee = payees.find(p => schedule._payee === p.id);
      const account = accounts.find(a => schedule._account === a.id);
      const amount = getScheduledAmount(schedule._amount);
      const amountStr =
        (schedule._amountOp === 'isapprox' || schedule._amountOp === 'isbetween'
          ? '~'
          : '') +
        (amount > 0 ? '+' : '') +
        format(Math.abs(amount || 0), 'financial');
      const dateStr = schedule.next_date
        ? monthUtilFormat(schedule.next_date, dateFormat)
        : null;

      return (
        filterIncludes(schedule.name) ||
        filterIncludes(payee && payee.name) ||
        filterIncludes(account && account.name) ||
        filterIncludes(amountStr) ||
        filterIncludes(statuses.get(schedule.id)) ||
        filterIncludes(dateStr)
      );
    });
  }, [payees, accounts, schedules, filter, statuses, format, dateFormat]);

  const items: readonly SchedulesTableItem[] = useMemo(() => {
    if (!groupBy || groupBy === 'nothing') {
      const unCompletedSchedules = filteredSchedules.filter(s => !s.completed);

      if (!allowCompleted) {
        return unCompletedSchedules;
      }
      if (showCompleted) {
        return filteredSchedules;
      }

      const hasCompletedSchedule = filteredSchedules.find(s => s.completed);

      if (!hasCompletedSchedule) return unCompletedSchedules;

      return [...unCompletedSchedules, { id: 'show-completed' }];
    }

    const visibleSchedules =
      allowCompleted && showCompleted
        ? filteredSchedules
        : filteredSchedules.filter(s => !s.completed);

    const hasCompletedSchedules =
      allowCompleted &&
      !showCompleted &&
      filteredSchedules.some(s => s.completed);

    if (groupBy === 'frequency') {
      const groups = new Map<
        string,
        { order: number; items: ScheduleEntity[] }
      >();

      for (const schedule of visibleSchedules) {
        const { label, order } = getFrequencyGroupInfo(schedule, t);
        if (!groups.has(label)) {
          groups.set(label, { order, items: [] });
        }
        groups.get(label).items.push(schedule);
      }

      const sortedGroups = Array.from(groups.entries()).sort(
        ([, a], [, b]) => a.order - b.order,
      );

      const result: SchedulesTableItem[] = [];
      for (const [label, { items: groupItems }] of sortedGroups) {
        const groupId = `group-freq-${label}`;
        const totalAmount = groupItems.reduce(
          (sum, s) => sum + getScheduledAmount(s._amount),
          0,
        );
        result.push({
          id: groupId,
          type: 'group-header',
          label,
          totalAmount,
        });
        if (!collapsedGroups.has(groupId)) {
          result.push(...groupItems);
        }
      }

      if (hasCompletedSchedules) {
        result.push({ id: 'show-completed' });
      }

      return result;
    }

    if (groupBy === 'category') {
      const groups = new Map<
        string,
        Array<ScheduleEntity | SplitScheduleItem>
      >();

      for (const schedule of visibleSchedules) {
        const cats = getScheduleCategories(schedule);

        if (cats.length === 1) {
          const catKey = cats[0].categoryId ?? 'uncategorized';
          if (!groups.has(catKey)) groups.set(catKey, []);
          groups.get(catKey).push(schedule);
        } else {
          for (const cat of cats) {
            const catKey = cat.categoryId ?? 'uncategorized';
            if (!groups.has(catKey)) groups.set(catKey, []);
            groups.get(catKey).push({
              id: `split-${schedule.id}-${cat.splitIndex}`,
              type: 'split',
              schedule,
              categoryId: cat.categoryId,
              amount: cat.amount,
            });
          }
        }
      }

      const sortedEntries = Array.from(groups.entries()).sort(
        ([keyA], [keyB]) => {
          if (keyA === 'uncategorized') return 1;
          if (keyB === 'uncategorized') return -1;
          const nameA = categoriesById.get(keyA)?.name ?? '';
          const nameB = categoriesById.get(keyB)?.name ?? '';
          return nameA.localeCompare(nameB);
        },
      );

      const result: SchedulesTableItem[] = [];
      for (const [catKey, scheduleItems] of sortedEntries) {
        const groupId = `group-cat-${catKey}`;
        const label =
          catKey === 'uncategorized'
            ? t('Uncategorized')
            : (categoriesById.get(catKey)?.name ?? t('Unknown'));
        const totalAmount = scheduleItems.reduce((sum, item) => {
          if ('type' in item && item.type === 'split') {
            return sum + (item as SplitScheduleItem).amount;
          }
          return sum + getScheduledAmount((item as ScheduleEntity)._amount);
        }, 0);
        result.push({
          id: groupId,
          type: 'group-header',
          label,
          totalAmount,
        });
        if (!collapsedGroups.has(groupId)) {
          result.push(...scheduleItems);
        }
      }

      if (hasCompletedSchedules) {
        result.push({ id: 'show-completed' });
      }

      return result;
    }

    if (groupBy === 'account') {
      const groups = new Map<string, ScheduleEntity[]>();

      for (const schedule of visibleSchedules) {
        const accountKey = schedule._account ?? 'unknown';
        if (!groups.has(accountKey)) groups.set(accountKey, []);
        groups.get(accountKey).push(schedule);
      }

      const sortedEntries = Array.from(groups.entries()).sort(
        ([keyA], [keyB]) => {
          if (keyA === 'unknown') return 1;
          if (keyB === 'unknown') return -1;
          const nameA = accounts.find(a => a.id === keyA)?.name ?? '';
          const nameB = accounts.find(a => a.id === keyB)?.name ?? '';
          return nameA.localeCompare(nameB);
        },
      );

      const result: SchedulesTableItem[] = [];
      for (const [accountKey, groupItems] of sortedEntries) {
        const groupId = `group-acct-${accountKey}`;
        const label =
          accountKey === 'unknown'
            ? t('Unknown')
            : (accounts.find(a => a.id === accountKey)?.name ?? t('Unknown'));
        const totalAmount = groupItems.reduce(
          (sum, s) => sum + getScheduledAmount(s._amount),
          0,
        );
        result.push({ id: groupId, type: 'group-header', label, totalAmount });
        if (!collapsedGroups.has(groupId)) {
          result.push(...groupItems);
        }
      }

      if (hasCompletedSchedules) {
        result.push({ id: 'show-completed' });
      }

      return result;
    }

    return filteredSchedules;
  }, [
    filteredSchedules,
    showCompleted,
    allowCompleted,
    groupBy,
    t,
    categoriesById,
    accounts,
    collapsedGroups,
  ]);

  function toggleGroupCollapse(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function renderItem({ item }: { item: SchedulesTableItem }) {
    if (item.id === 'show-completed') {
      return (
        <Row
          height={ROW_HEIGHT}
          inset={15}
          style={{
            cursor: 'pointer',
            backgroundColor: 'transparent',
            ':hover': { backgroundColor: theme.tableRowBackgroundHover },
          }}
          onClick={() => setShowCompleted(true)}
        >
          <Field
            width="flex"
            style={{
              fontStyle: 'italic',
              textAlign: 'center',
              color: theme.tableText,
            }}
          >
            <Trans>Show completed schedules</Trans>
          </Field>
        </Row>
      );
    }

    if ('type' in item && item.type === 'group-header') {
      const headerItem = item as GroupHeaderItem;
      return (
        <GroupHeaderRow
          groupId={headerItem.id}
          label={headerItem.label}
          totalAmount={headerItem.totalAmount}
          collapsed={collapsedGroups.has(headerItem.id)}
          onToggle={toggleGroupCollapse}
          minimal={minimal}
        />
      );
    }

    if ('type' in item && item.type === 'split') {
      const splitItem = item as SplitScheduleItem;
      return (
        <ScheduleRow
          schedule={splitItem.schedule}
          statuses={statuses}
          dateFormat={dateFormat}
          onSelect={onSelect}
          onAction={onAction}
          minimal={minimal}
          overrideAmount={splitItem.amount}
        />
      );
    }

    return (
      <ScheduleRow
        schedule={item as ScheduleEntity}
        {...{ statuses, dateFormat, onSelect, onAction, minimal }}
      />
    );
  }

  return (
    <View style={{ ...styles.tableContainer, ...tableStyle }}>
      <TableHeader height={ROW_HEIGHT} inset={15}>
        <Field width="flex">
          <Trans>Name</Trans>
        </Field>
        <Field width="flex">
          <Trans>Payee</Trans>
        </Field>
        <Field width="flex">
          <Trans>Account</Trans>
        </Field>
        <Field width={110}>
          <Trans>Next date</Trans>
        </Field>
        <Field width={120}>
          <Trans>Status</Trans>
        </Field>
        <Field width={100} style={{ textAlign: 'right' }}>
          <Trans>Amount</Trans>
        </Field>
        {!minimal && (
          <Field width={80} style={{ textAlign: 'center' }}>
            <Trans>Recurring</Trans>
          </Field>
        )}
        {!minimal && <Field width={40} />}
      </TableHeader>
      <Table
        loading={isLoading}
        rowHeight={ROW_HEIGHT}
        backgroundColor="transparent"
        style={{ flex: 1, backgroundColor: 'transparent', ...style }}
        items={items as ScheduleEntity[]}
        renderItem={renderItem}
        renderEmpty={filter ? t('No matching schedules') : t('No schedules')}
      />
    </View>
  );
}
